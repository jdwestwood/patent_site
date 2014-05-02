// EPO API info: app = patentvis; consumer key = 1AkwKESBGt6CrDDvjXMZtpbCteL0vyva; secret key =  zqXHPEuQCw5tyLGY

var express = require('express');                         // use 'npm install express' to install this nodejs package
var http = require('http');                               // part of nodejs
var https = require('https');
var fs = require('fs');
var request = require('request');                         // external package for http requests
var cheerio = require('cheerio');   // external package like jQuery for manipulating HTML and XML docs (does not execute scripts)
var crypto = require('crypto');                           // part of nodejs

// memcached (local server) or MemCachier (Heroku) client; on local server; start memcached server using 'memcached -vv -d';
// on Heroku, need to add the MemCachier service; default server:port is 127.0.0.1:11211
var ONE_WEEK = 7*24*60*60;                // cache expiration time in seconds
var MemJS = require('memjs').Client;      // external package; memjs is the memcached client used on Heroku that also works locally
// creat the memcache (local) or MemCachier (Heroku) client; the first argument is the config string for the memcached
// server and port, which has the form "[user:pass@]server1:[11211]"; on the local EC2 instance, the empty string defaults
// to 127.0.0.1:11211.
var memjs = MemJS.create("", {expires: ONE_WEEK});

// var buf = require('buf');

// EPO access:
var CONSUMER_KEY = '1AkwKESBGt6CrDDvjXMZtpbCteL0vyva';
var SECRET_KEY = 'zqXHPEuQCw5tyLGY';
var GETTING_ACCESS_TOKEN = false;                      // do not persist an access key; it just causes problems!
var QUERYING_FOR_BIBLIO_DATA = false;

var DEBUG_FLAG;
process.argv.forEach(function(value) {                 // get debug flag, if any, from command line and set DEBUG_FLAG
    switch (value) {
      case '-d': case '-debug':
        DEBUG_FLAG = true;
        break;
      default:
        DEBUG_FLAG = false;
    }
  });

var indexFile = (DEBUG_FLAG) ? 'indexDev.html' : 'index.html';   // set homepage file according to DEBUG_FLAG

function createRandomNo() {
// create a random number as a base64 string.
  var hash = crypto.createHash('sha1');
  var seed = Math.random().toString();
  hash.update(seed, 'utf8');
  return hash.digest('base64');
}

var googleHost = 'www.google.com';
var googleURL = '';
var googlePath = '';
var googleReqParam = {};
var googleReq;0

var app = express();                                    // create the server

// set secret for signed cookies; signed cookies prove that request back from client is using a cookie that came from
// this server
var cookieSecret = createRandomNo();
app.use(express.cookieParser(cookieSecret));

// track user sessions
var sessionCookie = 'yappee_id';
var clientCookie = 'yappee_cl';
var sessionList = {};

// express.logger is the same as connect.logger - documentation is at www.senchalabs.org/connect/logger.html
app.use(express.logger('default'));
// give access to 'lib' directory tree so can serve .css and .js files referenced in index.html  
app.use(express.static(__dirname + '/lib'));
app.use('/epoapi/biblio/', express.bodyParser()); // bodyParser is used by express request.body to parse the body of a POST request

var indexHTML = fs.readFileSync(indexFile, {'encoding': 'utf-8'});           // returns a buffer unless encoding is specified

app.get('/*', function(clientReq, serverResp) {         // clientReq is an instance of express Request object, which inherits from
  var url = clientReq.url;
  var sValue = clientReq.signedCookies[sessionCookie];
  var cValue = clientReq.signedCookies[clientCookie];
  switch (true) {                              // http.IncomingMessage and stream.Readable; serverResp is an instance of express
    case url == '/' || url == '/yappee/':               // Response object, inherits from http.ServerResponse stream.Writable
      clientReqLogging(clientReq, 'GET');
      // if client requests the main page '/' and does not have an sessionCookie
      if (!sValue) {
        var sValue = createRandomNo();
        // send a session cookie; 'httpOnly' means not accessible from javascript on the client side; default 'domain'
        // is the domain of this server; default path is '/' (i.e., all paths that begin with '/'); do not send from
        // https only ('secure' not set).
        serverResp.cookie(sessionCookie, sValue, {signed: true, httpOnly: true});  // send session cookie
      }
      // create a clientCookie will be accessed by client-side javascript and returned with each subsequent HTTP request
      var cValue = createRandomNo();
      sessionList[sValue] = {"cValue": cValue};
      serverResp.cookie(clientCookie, cValue, {signed: true});                    // send client cookie
      serverResp.send(indexHTML);
      break;
    default:
      // if GET request has valid session cookie (generated by server) and client-generated cookie present with value
      // the same as the session cookie, then send the request on to Google.
      if (sValue && sessionList[sValue] && sessionList[sValue]["cValue"] == cValue) {
        debug("Received GET request from valid session " + sValue + " and client ", cValue);
        googleReqHeader = prepGoogleReqHeader(clientReq);
        // make all requests to Google as https: to port 443, but send responses and redirects back to client as http: on port 8080
        googleReqParam = HTTPRequestParameters(googleHost, url, 'GET', 443, googleReqHeader);
        googleReq = https.request(googleReqParam, function(googleResp) {
                                                    processRes(googleReqParam, googleResp, clientReq, serverResp);
                                                  });
        googleReq.end();
      }
      else {
        serverResp.send(404);
        clientReqLogging(clientReq, 'GET');
        console.log("\nResponded to GET request with 404 error");
        debug("GET request had invalid cookie values: session cookie was " + sValue + 
                    "\nand client cookie was " + cValue + ". Request details are: ");
      }
      break;
  }
});

app.head('/*', function(clientReq, serverResp) {
  var url = clientReq.url;
  var sValue = clientReq.signedCookies[sessionCookie];
  var cValue = clientReq.signedCookies[clientCookie];
  debug("\nHEAD request received for " + url);
  // if HEAD request has valid session cookie (generated by server) and valid client cookie (generated by javascript in the
  // client), then send the request on to Google.
  if (sValue && sessionList[sValue] && sessionList[sValue]["cValue"] == cValue) {
    switch (true) {
      case /^\/patents\//.test(url):
        googleReqHeader = prepGoogleReqHeader(clientReq);
        googleReqParam = HTTPRequestParameters(googleHost, url, 'HEAD', 443, googleReqHeader);
        googleReq = https.request(googleReqParam, function(googleResp) {
                                                    processRes(googleReqParam, googleResp, clientReq, serverResp);
                                                  });
        googleReq.end();
        break;
    }
  }
  else {                                             // invalid cookies
    serverResp.send(404);
    clientReqLogging(clientReq, 'HEAD');
    console.log("\nResponded to HEAD request with 404 error");
    debug("HEAD request had invalid cookie values: session cookie was " + sValue + " and client cookie was " + cValue);
  }
});

app.post('/*', function(clientReq, serverResp) {     // clientReq is an instance of express Request object, which inherits from
  var url = clientReq.url;                           // http.IncomingMessage and stream.Readable; serverResp is instance of express
  var sValue = clientReq.signedCookies[sessionCookie];     // Response object, inherits from http.ServerResponse stream.Writable
  var cValue = clientReq.signedCookies[clientCookie];
  // if POST request has valid session cookie (generated by server) and valid client cookie (generated by javascript in the
  // client), then send the request to the EPO API.
  if (sValue && sessionList[sValue] && sessionList[sValue]["cValue"] == cValue) {
    switch (true) {
      case url == '/' || url == '/yappee/':            // do not respond to POST request
        clientReqLogging(clientReq, 'POST');
        break;
    case url == '/epoapi/biblio/':
        express.bodyParser(clientReq);                   // make body of POST request available via clientReq.body
        var cacheKey = clientReq.body['CacheKey'];
        debug("\nCacheKey from clientReq: " + cacheKey);
        var nTries = 0;                                  // number of attempts to retrieve the EPO biblio data
        if (cacheKey) {                                  // requesting the results to be pulled from cache; if not
          memjs.get(cacheKey, on_cacheget_EPO_data);
        }
        else {
          getNewBiblioData();
        }

        function on_cacheget_EPO_data(err, EPO_biblio_buf, key) {
          // callback for memjs.get for GET POST request for EPO data; EPO_biblio_buf and key are buffers if the key is
          // and null otherwise
          if (EPO_biblio_buf) {
            debug("Sending biblio data for " + cacheKey + " from cache");
            serverResp.send(EPO_biblio_buf.toString());
            return;
          }
          else {
            debug("Key" + cacheKey + " not in cache. Query EPO...");
            getNewBiblioData();
          }
        }

        function getNewBiblioData() {
          // request an access token from EPO and call back getEPOBiblio when done;
          getAccessToken(getEPOBiblio);                                     // getEPOBiblio is the callback
        }

        function getEPOBiblio(access_token, error_message) {              // callback function for getAccessToken
          QUERYING_FOR_BIBLIO_DATA = true;
          setTimeout(function() {QUERYING_FOR_BIBLIO_DATA = false;}, 100);    // space EPO API queries at least 100 msec apart
          if (access_token) {
            patent_list = clientReq.body['Request Body'];
            getEPOBiblioData(access_token, patent_list, sendEPOData);     // sendEPOData is the callback
            nTries += 1;
          }
          else {
           sendEPOData(null, error_message);                              // send error_message from getAccessToken
          }
        }

        function sendEPOData(jsonStr, error_message) {                    // callback function for getEPOBiblioData
          if (jsonStr) {                                                  // got EPO biblio data so send it and cache it
            debug("In sendEPODdata, cacheKey is: " + cacheKey);
            serverResp.send(jsonStr);
            if (cacheKey) {
              memjs.set(cacheKey, jsonStr, on_cacheset_EPO_data, ONE_WEEK);
            }            
          }
          else {                                                          // did not get EPO biblio data back
            debug("In sendEPOData, nTries: ", nTries);
            if (error_message.message == "invalid_access_token" && nTries == 1) {   // either an invalid access token ...
              nTries += 1;
              debug("In sendEPOData, access token was invalid (probably expired); get a fresh one");
              memjs.delete("access_obj", on_delete_expired_EPO_access_token);
            }
            else {                                                                  // or some other error
             debug("In sendEPOData, error in getting access token or querying EPO API: " + JSON.stringify(error_message));
             serverResp.send(JSON.stringify(error_message));
            }
          }
        }

        function on_delete_expired_EPO_access_token(err, success) {
        // access token was expired at EPO but not in memcache; callback for memjs.delete in sendEPOData
          // get a valid access token (this time from EPO).
          getAccessToken(getEPOBiblio);                               // getEPOBiblio is the callback        
        }

        function on_cacheset_EPO_data(err, success) {
        // callback for memjs.set in sendEPOData; 'success' is true if the .set succeeded
          if (success) {
            debug("Cached EPO biblio data with key " + cacheKey);
          }
          else {
            debug("In on_cache_EPO_data, cache failed");
          }
        }

        break;
      default:
        googleReqHeader = prepGoogleReqHeader(clientReq);
        googleReqParam = HTTPRequestParameters(googleHost, url, 'POST', 80, googleReqHeader);
        googleReq = http.request(googleReqParam, function(googleResp) {
                                                   processRes(googleReqParam, googleResp, clientReq, serverResp);
                                                 });
        // 'data' and 'end' events inherited from nodejs Readable stream
        clientReq.on('data', function(chunk) {googleReq.write(chunk);} );
        clientReq.on('end', function() { googleReq.end();} );
    }
  }
  else {                                                           // invalid Cookies, do not respond
    serverResp.send(404);
    clientReqLogging(clientReq, 'POST');
    console.log("\nResponded to POST request with 404 error");
    debug("POST request had invalid cookie values: session cookie was " + sValue + " and client cookie was " + cValue);
  }
});

function looksLikeJSON(jsonStr) {
  return (jsonStr[0] == '{' && jsonStr.slice(-1) == '}');
}

function getEPOBiblioData(access_token, patent_list, callback) {
  // get the requested EPO bibliographic patent data using the access_token;
  // the callback function is sendEPOData with arguments jsonStr containing the data
  // in json format and error_message (JSON object)
  console.log("Querying EPO API for patent biblio data at " + Date.now()); 
  request.post({url: "https://ops.epo.org/3.1/rest-services/published-data/publication/epodoc/biblio",
                headers: {"Authorization": "Bearer " + access_token,
                          "Accept": "application/json"},
                // also sets header Content-Type: "application/x-www-form-urlencoded; charset=UTF-8")
                form: {"Request Body": patent_list}
                },
      function(error, response, body) {               // error is a request error object, not an HTTP error
        debug("getEPOBiblioData response statusCode: " + response.statusCode);
        if (!error) {
          switch (response.statusCode) {
            case 200:
              if (looksLikeJSON(body)) {              // if it looks like JSON, call back with patent data
                debug("In getEPOBiblioData, sending patent data");
                callback(body, null);
              }
              else {                                  // it is an error message in XML - should never happen with statusCode 200???
                var error_message = getEPOError(response, body);
                console.log("In getEPOBiblioData, error from EPO server: " + JSON.stringify(error_message));
                callback(null, error_message);
              }
              break;
            case 400: case 401: case 403: case 404: case 405: case 413: case 500: case 503: case 504: default:
              var error_message = getEPOError(response, body);
              console.log("In getEPOBiblioData, error from EPO server: " + JSON.stringify(error_message));
              callback(null, error_message);
              break;
          }
        }
        else {
          var error_message = getHTTPError(response, "", body, "", "Error from request in getEPOBiblioData");
          console.log("In getEPOBiblioData, HTTP error: " + JSON.stringify(error_message));
          console.log("Error object from request: ", error);
          callback(null, error_message);
        }
     });
}

function getAccessToken(callback) {
  // get the EPO access token; check cache, and if not there get one from EPO
  // the callback function arguments are access_token (string), error_message (JSON object)
  if (!GETTING_ACCESS_TOKEN && !QUERYING_FOR_BIBLIO_DATA) {
    GETTING_ACCESS_TOKEN = true;
    memjs.get('JSON_access', on_get_access_token); 
  }
  else {
    debug("Waiting for previous query for access token or patent data to complete...");
    setTimeout(getAccessToken, 15, callback);
  }

  function on_get_access_token(err, access_buf, key) {
  // callback for memjs.get access_obj above; access_buf is a buffer containing access_obj
    if (access_buf) {
      var JSON_access = access_buf.toString();
      var access_obj = JSON.parse(JSON_access);
      debug("In getAccessToken, got EPO access token from cache: " + access_obj['access_token']);
      GETTING_ACCESS_TOKEN = false;
      callback(access_obj['access_token'], null);
    }
    else {
      debug("In getAccessToken, failed to get access key from cache, so query EPO for one.");
      getNewAccessToken(callback);
    }
  }
}

function getNewAccessToken(callback) {
  // POST request to EPO for new access token;
  // call the callback with arguments access_token and error_message when done.
  request.post({url: "https://ops.epo.org/3.1/auth/accesstoken",
                auth: {"user": CONSUMER_KEY,
                       "pass": SECRET_KEY},
                // also sets header Content-Type: "application/x-www-form-urlencoded; charset=UTF-8")
                form: {"grant_type": "client_credentials"}
                },
     function(error, response, JSON_access) {             // error is a request error object, not an HTTP error
       debug("In getNewAccessToken response statusCode: " + response.statusCode + "; with JSON: " + JSON_access);
       if (!error) {
         switch (response.statusCode) {
           case 200:
             if (looksLikeJSON(JSON_access)) {            // if it looks like JSON, cache it and call back
               // 'access_token' and 'expires_in' for the token and expiration time, which is a string in sec
               var access_obj = JSON.parse(JSON_access);
               var access_token = access_obj["access_token"];
               var expires = parseInt(access_obj["expires_in"]);
               memjs.set('JSON_access', JSON_access, on_set_access_token, expires);
               GETTING_ACCESS_TOKEN = false;
               debug("New access token from EPO: " + access_token);
               callback(access_token, null);
             }
             else {                                     // it is an error message in XML
               var error_message = getEPOError(response, body);
               console.log("In getNewAccessToken, error from EPO server: ", JSON.stringify(error_message));
               callback(null, error_message);
             }
             break;
           case 400: case 401: case 403: case 404: case 405: case 413: case 500: case 503: case 504: default:
             var error_message = getEPOError(response, body);
             console.log("In getNewAccessToken, error from EPO server: " + JSON.stringify(error_message));
             callback(null, error_message);
             break;
         }
       }
       else {
         var error_message = getHTTPError(response, "", body, "", "Error from request in getNewAccessToken");
         console.log("In getNewAccessToken, HTTP error: " + JSON.stringify(error_message));
         console.log("Error object from request: ", error);
         callback(null, error_message);
       }

       function on_set_access_token(err, success) {
       // callback for memjs.set for JSON_access
         if (success) {
           debug("In getNewAccessToken, set new EPO access JSON in cache.");
         }
         else {
           debug("In getNewAccessToken, failed to set new EPO access JSON in cache");
         }
       }
     });
}

function getEPOError(response, body) {
  // parse an EPO error response body, which is in XML
  var $ = cheerio.load(body, {xmlMode: true});
  var EPO_error_code = $("code").text();
  var EPO_error_message = $("message").text();
  var EPO_error_description = $("description").text();
   // XML starts with <error> tag
   // 400 message could be invalid_request, invalid_client, unsupported_grant_type, invalid_access_token
   // 401 (Unauthorized) status code to indicate which HTTP authentication schemes are supported
   // 403 description could be "This request has been rejected due to the violation of Fair Use policy" (usage rate exceeded)
   //     (no message)         "This request has been rejected" if resource is blacklisted (due to too busy or other cause,
   //                           see my EPO notes)
   //                          "Developer account is blocked" (uh-oh).
  if ($("error").length > 0) {                             // an <error> tag encloses the error message
    var error_message = getHTTPError(response, EPO_error_code, EPO_error_message, EPO_error_description,
                                     "EPO request layer 2 error");
  }
   // XML starts with <fault> tag
   // 400 code could be CLIENT.InvalidQuery or CLIENT.CQL
   // 403 code CLIENT.RobotDetected
   // 404 code could be CLIENT.InvalidReference, CLIENT.WrongReferenceFormatting, CLIENT.NotFound, SERVER.EntityNotFound
   // 405 code CLIENT.MethodNotAllowed
   // 413 code CLIENT.Ambiguous Request
   // 500 code SERVER.DomainAccess (request could not be processed; try again later)
   // 503 code SERVER.LimitedServerResources (Temporarily unavailable)
   // 504 code SERVER.????                   (Please reduce query size)
  else {                                                   // a <fault> tag encloses the error message
    var error_message = getHTTPError(response, EPO_error_code, EPO_error_message, EPO_error_description,
                                     "EPO request layer 1 error");
  }
  return error_message;
}

function getHTTPError(response, code, message, description, source) {
  // create an error object using response.statusCode and the message string
  return {"Response status code": response.statusCode,
          "EPO error code": code,
          "message": message,
          "description": description,
          "source": source};
}

function prepGoogleReqHeader(clientReq) {
  console.log('\nIn prepGoogleReqHeader, received clientReq from ' + clientReq.ip + ' for host \'' + clientReq.headers['host']
                + '\' and url \'' + clientReq.url + '\'');
  var googleReqHeader = JSON.parse(JSON.stringify(clientReq.headers));
  delete googleReqHeader.host;
  debug("In prepGoogleReqHeader, incoming header is", googleReqHeader);
  prepareHeaderCookies(googleReqHeader);
  delete googleReqHeader.referer;
  debug('Header for request to Google: ', googleReqHeader);
  return googleReqHeader;
}

function prepareHeaderCookies(header) {
// remove sessionCookie and clientCookie from HTTP header 'header' object
  var cookieList = header['cookie'].split('; ');
debug("Incoming cookieList: ", cookieList);
  var cookieNameList = cookieList.map(function(s) {return s.slice(0, s.indexOf('='));});
  removeCookie(sessionCookie);
  removeCookie(clientCookie);
  var newCookieList = cookieList.filter(function(s) {return (s != "");});
  if (newCookieList.length > 0) {
    header['cookie'] = newCookieList.join('; ');
  }
  else {
    delete header['cookie'];
  }
debug("Outgoing newCookieList: ", newCookieList);

  function removeCookie(cookieName) {
  // removes cookieName from cookieList
    var i = cookieNameList.indexOf(cookieName);
    if (i != -1) {
      cookieList[i] = "";
    }
    else {
      debug("In removeCookie, did not find cookie: " + cookieName);
    }
  }
}

function clientReqLogging(clientReq, type) {
    console.log('\nIn clientReqLogging, received ' + type + ' request from ' + clientReq.ip + 
                '\nfor host \'' + clientReq.headers['host'] + '\' and url \'' + clientReq.url + 
                '\'\nwith referer \'' + clientReq.headers['referer']) + '\'';
    debug('\nRequest headers are:\n', clientReq.headers);
}

var port = process.env.PORT || 8080                 // 5000 was default setting; 8080 is conventional setting for website debug
app.listen(port, function() {
  console.log("Listening on " + port);
});

function processRes(extReq, extResp, clientReq, serverResp) {
// extReq is an object returned from HTTPRequestParameters - instance of http.ServerResponse;
// extResp is instance of http.IncomingMessage; clientReq is instance of express Request object
// and serverResp is instance of express Response object (as described above)

  console.log('\nIn processRes, response statusCode: ' + extResp.statusCode);
  debug(extResp.headers);

  // make copy of the extResp headers, so can modify them if needed before relaying to the client
  serverRespHeader = JSON.parse(JSON.stringify(extResp.headers));

  // clientReq has been redirected; need to substitute the server host for the external host in the redirected location url
  if (extResp.statusCode == '302') {
    var extRedirectedLoc = extResp.headers['location'];
    var serverRedirectedLoc = extRedirectedLoc.replace(extReq['host'], clientReq.headers['host']);
      // make all requests to Google as https: to port 443, but send responses and redirects back to client as http: on port 8080
    serverRedirectedLoc = serverRedirectedLoc.replace('https', 'http');
    debug('extRedirectedLoc: ' + extRedirectedLoc);
    debug('serverRedirectedLoc: ' + serverRedirectedLoc);
    serverRespHeader['location'] = serverRedirectedLoc;
  }

  serverResp.writeHead(extResp.statusCode, serverRespHeader);

  extResp.on('data', function(chunk) {
      serverResp.write(chunk);
  });
  extResp.on('end', function() {
    serverResp.end();
  });
}

function HTTPRequestParameters(host, path, method, port, headers) {
  return {host: host,
          path: path,
          method: method,
          port: port,
          headers: headers
         };
}

function debug() {
// use debug() instead of console.log() to control when logging to console occurs with DEBUG_FLAG.
  DEBUG_FLAG && console.log.apply(console, arguments);
}
