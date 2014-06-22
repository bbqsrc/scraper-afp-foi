var cheerio = require('cheerio'),
    request = require('request'),
    moment = require('moment'),
    async = require('async'),
    Sequelize = require('sequelize'),
    url = require('url'),
    path = require('path'),
    fs = require('fs'),

    MAX_PARALLEL = 6,
    DB_PATH = __dirname + '/data.sqlite',
    FOI_URL = "http://www.afp.gov.au/about-the-afp/information-publication-scheme" + 
             "/routinely-requested-information.aspx",

    sequelize = new Sequelize('afp', '', '', {
        dialect: 'sqlite',
        storage: DB_PATH,
        logging: false // oh god so verbose
    }),
    Request, Resource;


Request = sequelize.define("Request", {
    disclosureRefNo: Sequelize.STRING,
    foiRequestRefNo: Sequelize.STRING,
    publishedDate: Sequelize.DATE,
    description: Sequelize.TEXT,
    docURL: Sequelize.STRING,
    removalDate: Sequelize.DATE,
    otherInfo: Sequelize.TEXT
});


Resource = sequelize.define("Resource", {
    fileName: Sequelize.STRING,
    data: Sequelize.BLOB,
    url: Sequelize.STRING,
    contentType: Sequelize.STRING
});


Request.hasMany(Resource);
Resource.belongsTo(Request);


function parseCells($, nodes) {
    return {
        disclosureRefNo: $(nodes[0]).text().trim(),
        foiRequestRefNo: $(nodes[1]).text().trim(),
        publishedDate: moment($(nodes[2]).text().trim(), "D/M/YYYY").toDate(),
        description: $(nodes[3]).text().trim(),
        // XXX: not handled well at the moment, unclear purpose
        docURL: null, 
        removalDate: moment($(nodes[5]).text().trim(), "D/M/YYYY").toDate(),
        otherInfo: $(nodes[6]).text().trim()
    };
}


function createRequestRecord(data, callback) {
    Request.create(data).success(function(record) {
        if (data.docURL) {
            console.log("- Scraping: '" + data.docURL + "'");

            request({ url: data.docURL, encoding: null }, function(err, resp, body) {
                if (err) return callback(err);

                if (resp.statusCode == 200) {
                    var fn = path.basename(data.docURL);

                    // lol afp
                    if (/\.pdf$/.test(fn) && resp.headers['content-type'] == "application/pdf") {
                        fn += ".pdf";
                    }
                }
                
                Resource.create({
                    fileName: fn,
                    data: body,
                    url: data.docURL,
                    contentType: resp.headers['content-type']
                }).success(function(resRecord) {
                    record.addResource(resRecord);
                    resRecord.setRequest(record);

                    return callback(null);
                }).failure(function(err) {
                    return callback(err);
                });
            });
        } else {
            return callback(null);
        }
    }).failure(function(err) {
        return callback(err);
    });
}

function createParsingTask(data) {
    return function(callback) {
        Request.find({ where: { disclosureRefNo: data.disclosureRefNo } }).success(function(exists) {
            if (exists) {
                console.log("- Record found, skipping.");
                return callback(null);
            }

            return createRequestRecord(data, callback);
        }).failure(function(err) {
            return callback(err);
        });
    }
}

// MAIN LOOP GOGOGOGOGOGO
sequelize.sync().success(function() {
    // Get the FOI list.
    request(FOI_URL, function(err, resp, body) {
        // TODO: handle the error case
        if (err) throw err;

        if (resp.statusCode == 200) {
            var $ = cheerio.load(body),
                rows = [];

            $("table.foi-disclosure tbody > tr:not(:first-child)").each(function() {
                var nodes = $(this).children(),
                    o = parseCells($, nodes),
                    docURL = $(nodes[3]).find("a");

                // This'll do for now. Should update when multiple docs appear.
                if (docURL.length) {
                    o.docURL = url.resolve(FOI_URL, docURL.attr('href'));
                }

                rows.push(createParsingTask(o));
            });

            async.parallelLimit(rows, MAX_PARALLEL, function(err, results) {
                if (err) console.error(err);
                else console.log("Done!");
            });
        } else {
            console.error("Request '" + FOI_URL + "' returned status code " + 
                          resp.statusCode + ".");
        }
    });
}).failure(function(err) {
    throw err;
});
