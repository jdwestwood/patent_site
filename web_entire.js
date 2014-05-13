// 5/13/2014: this is the original version of web.js that combines serving the main page, the Google content, and the EPO
// query results; when I deployed to Heroku, I discovered that EPO OPS blacklists some of the Heroku servers; so I
// moved EPO querying out of web.js into web_EPO.js; I now deploy web.js on Heroku and run web_EPO.js on my AWS
// development server.

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
const CONSUMER_KEY = process.env.CONSUMER_KEY;
const SECRET_KEY = process.env.SECRET_KEY;
var GETTING_ACCESS_TOKEN = false;               // do not persist an access key; it just causes problems!
var QUERYING_FOR_BIBLIO_DATA = false;
// secret for signed cookies; use an environmental variable so secret stays the same across server restarts
const COOKIE_SECRET = process.env.COOKIE_SECRET;

var DEBUG_FLAG = false;
process.argv.forEach(function(value) {                 // get debug flag, if any, from command line and set DEBUG_FLAG
    switch (value) {
      case '-d': case '-debug':
        DEBUG_FLAG = true;
        break;
      default:                                         // if not set on command line, check environment variable DEBUG
        if (process.env.DEBUG && process.env.DEBUG.toLowerCase() == 'true') DEBUG_FLAG = true;
    }
  });

var indexFile = (DEBUG_FLAG) ? 'indexDev.html' : 'index.html';   // set homepage file according to DEBUG_FLAG

function createRandomString() {
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
app.use(express.cookieParser(COOKIE_SECRET));

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
  debug_log("\nGET request received for url:" + url);
  switch (true) {                              // http.IncomingMessage and stream.Readable; serverResp is an instance of express
    case url == '/' || url == '/yappee/':               // Response object, inherits from http.ServerResponse stream.Writable
      clientReqLogging(clientReq, 'GET');
      setupCookies(clientReq, serverResp);
      serverResp.send(indexHTML);
      break;
    default:
      // if GET request has valid session cookie (generated by server) and client-generated cookie present with value
      // the same as the session cookie, then send the request on to Google; otherwise send 404 error.
      verifyCookies(clientReq, processGETReq, denyGETReq);
      break;

      function processGETReq(success) {
      // callback for verifyCookies when the GET request has valid cookies; success is a string containing cookie values found
        debug_log(success);
        googleReqHeader = prepGoogleReqHeader(clientReq);
        // make all requests to Google as https: to port 443, but send responses and redirects back to client as http: on port 8080
        googleReqParam = HTTPRequestParameters(googleHost, url, 'GET', 443, googleReqHeader);
        googleReq = https.request(googleReqParam, function(googleResp) {
                                                    processRes(googleReqParam, googleResp, clientReq, serverResp);
                                                  });
        googleReq.end();
      }

      function denyGETReq(error) {
      // callback for verifyCookies when the GET request has invalid cookies; error is a string describing the error encountered.
        serverResp.send(404);
        clientReqLogging(clientReq, 'GET');
        debug_log(error);
        console.log("\nResponded to GET request with 404 error");
      }
  }
});

app.head('/*', function(clientReq, serverResp) {
  var url = clientReq.url;
  debug_log("\nHEAD request received for url:" + url);
  // if HEAD request has valid session cookie (generated by server) and valid client cookie (generated by javascript in the
  // client), then send the request on to Google; otherwise send 404 error.
  verifyCookies(clientReq, processHEADReq, denyHEADReq);

  function processHEADReq(success) {
  // callback for verifyCookies when the HEAD request has valid cookies.
    debug_log(success);
    switch (true) {
      case /^\/patents\//.test(url):
        googleReqHeader = prepGoogleReqHeader(clientReq);
        googleReqParam = HTTPRequestParameters(googleHost, url, 'HEAD', 443, googleReqHeader);
        googleReq = https.request(googleReqParam, function(googleResp) {
                                                    processRes(googleReqParam, googleResp, clientReq, serverResp);
                                                  });
        googleReq.end();
        break;
      default:
        // this should never happen
        console.log("Unexpected url in HEAD request.");
        denyHEADReq("Unexpected url in HEAD request with valid cookies");
    }
  }

  function denyHEADReq(error) {                                            // invalid cookies
  // callback for verifyCookies when the HEAD request has invalid cookies; error is a string describing the error encountered.
    serverResp.send(404);
    clientReqLogging(clientReq, 'HEAD');
    debug_log(error);
    console.log("\nResponded to HEAD request with 404 error");
  }
});

app.post('/*', function(clientReq, serverResp) {     // clientReq is an instance of express Request object, which inherits from
  var url = clientReq.url;                           // http.IncomingMessage and stream.Readable; serverResp is instance of express
  debug_log("\nPOST request received for url:" + url);   // Response object, inherits from http.ServerResponse stream.Writable
  // if POST request has valid session cookie (generated by server) and valid client cookie (generated by javascript in the
  // client), then send the request to the EPO API.
  verifyCookies(clientReq, processPOSTReq, denyPOSTReq);

  function processPOSTReq(success) {
  // callback for verifyCookies when the POST request has valid cookies.
    debug_log(success);
    clientReqLogging(clientReq, 'POST');
    switch (true) {
      case url == '/' || url == '/yappee/':            // do not respond to POST request
        break;
      case url == '/epoapi/biblio/':
        express.bodyParser(clientReq);                   // make body of POST request available via clientReq.body
        var cacheKey = clientReq.body['CacheKey'];
        debug_log("\nCacheKey from clientReq: " + cacheKey);
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
            debug_log("Sending biblio data for " + cacheKey + " from cache");
            serverResp.send(EPO_biblio_buf.toString());
            return;
          }
          else {
            debug_log("Key" + cacheKey + " not in cache. Query EPO...");
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
            debug_log("In sendEPODdata, cacheKey is: " + cacheKey);
            serverResp.send(jsonStr);
            if (cacheKey) {
              memjs.set(cacheKey, jsonStr, on_cacheset_EPO_data, ONE_WEEK);
            }            
          }
          else {                                                          // did not get EPO biblio data back
            debug_log("In sendEPOData, nTries: ", nTries);
            if (error_message.message == "invalid_access_token" && nTries == 1) {   // either an invalid access token ...
              nTries += 1;
              debug_log("In sendEPOData, access token was invalid (probably expired); get a fresh one");
              memjs.delete("access_obj", on_delete_expired_EPO_access_token);
            }
            else {                                                                  // or some other error
             debug_log("In sendEPOData, error in getting access token or querying EPO API: " + JSON.stringify(error_message));
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
            debug_log("Cached EPO biblio data with key " + cacheKey);
          }
          else {
            debug_log("In on_cache_EPO_data, cache failed");
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

  function denyPOSTReq(error) {                                        // invalid Cookies, do not respond
    serverResp.send(404);
    clientReqLogging(clientReq, 'POST');
    debug_log(error);
    console.log("\nResponded to POST request with 404 error");
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
        console.log("\nIn getEPOBiblioData, response statusCode: " + response.statusCode);
        console.log("In getEPOBiblioData, EPO usage response headers are:" +
                    "\n  date: " + response.headers['date'] +
                    "\n  x-individualquotaperhour-used: " + response.headers['x-individualquotaperhour-used'] +
                    "\n  x-registeredquotaperweek-used: " + response.headers['x-registeredquotaperweek-used'] +
                    "\n  x-throttling-control: " + response.headers['x-throttling-control'] +
                    "\n  x-rejection-reasonl: " + response.headers['x-rejection-reason']);

        if (!error) {
          switch (response.statusCode) {
            case 200:
              if (looksLikeJSON(body)) {              // if it looks like JSON, call back with patent data
                debug_log("In getEPOBiblioData, sending patent data");
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
    debug_log("Waiting for previous query for access token or patent data to complete...");
    setTimeout(getAccessToken, 15, callback);
  }

  function on_get_access_token(err, access_buf, key) {
  // callback for memjs.get access_obj above; access_buf is a buffer containing access_obj
    if (access_buf) {
      var JSON_access = access_buf.toString();
      var access_obj = JSON.parse(JSON_access);
      debug_log("In getAccessToken, got EPO access token from cache: " + access_obj['access_token']);
      GETTING_ACCESS_TOKEN = false;
      callback(access_obj['access_token'], null);
    }
    else {
      debug_log("In getAccessToken, failed to get access key from cache, so query EPO for one.");
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
       debug_log("In getNewAccessToken response statusCode: " + response.statusCode + "; with JSON: " + JSON_access);
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
               debug_log("New access token from EPO: " + access_token);
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
           debug_log("In getNewAccessToken, set new EPO access JSON in cache.");
         }
         else {
           debug_log("In getNewAccessToken, failed to set new EPO access JSON in cache");
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
  debug_log("In prepGoogleReqHeader, incoming header is", googleReqHeader);
  prepareHeaderCookies(googleReqHeader);
  delete googleReqHeader.referer;
  debug_log('Header for request to Google: ', googleReqHeader);
  return googleReqHeader;
}

function prepareHeaderCookies(header) {
// remove sessionCookie and clientCookie from HTTP header 'header' object
  var cookieList = header['cookie'].split('; ');
debug_log("Incoming cookieList: ", cookieList);
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
debug_log("Outgoing newCookieList: ", newCookieList);

  function removeCookie(cookieName) {
  // removes cookieName from cookieList
    var i = cookieNameList.indexOf(cookieName);
    if (i != -1) {
      cookieList[i] = "";
    }
    else {
      debug_log("In removeCookie, did not find cookie: " + cookieName);
    }
  }
}

function clientReqLogging(clientReq, type) {
    console.log('\nIn clientReqLogging, received ' + type + ' request from ' + clientReq.ip + 
                '\nfor host \'' + clientReq.headers['host'] + '\' and url \'' + clientReq.url + 
                '\'\nwith referer \'' + clientReq.headers['referer']) + '\'';
    debug_log('\nRequest headers are:\n', clientReq.headers);
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
  debug_log(extResp.headers);

  // make copy of the extResp headers, so can modify them if needed before relaying to the client
  serverRespHeader = JSON.parse(JSON.stringify(extResp.headers));

  // clientReq has been redirected; need to substitute the server host for the external host in the redirected location url
  if (extResp.statusCode == '302') {
    var extRedirectedLoc = extResp.headers['location'];
    var serverRedirectedLoc = extRedirectedLoc.replace(extReq['host'], clientReq.headers['host']);
      // make all requests to Google as https: to port 443, but send responses and redirects back to client as http: on port 8080
    serverRedirectedLoc = serverRedirectedLoc.replace('https', 'http');
    debug_log('extRedirectedLoc: ' + extRedirectedLoc);
    debug_log('serverRedirectedLoc: ' + serverRedirectedLoc);
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

function setupCookies(clientReq, serverResp) {
// called when user request the main page
  var sValue = clientReq.signedCookies[sessionCookie];
  var cValue = clientReq.signedCookies[clientCookie];
  // if client requests the main page '/' and does not have an sessionCookie
  if (!sValue) {
    var sValue = createRandomString();
    // send a session cookie; 'httpOnly' means not accessible from javascript on the client side; default 'domain'
    // is the domain of this server; default path is '/' (i.e., all paths that begin with '/'); do not send from
    // https only ('secure' not set).
    serverResp.cookie(sessionCookie, sValue, {signed: true, httpOnly: true});  // send session cookie
  }
  // create a clientCookie will be accessed by client-side javascript and returned with each subsequent HTTP request
  var cValue = createRandomString();
  sessionList[sValue] = {"cValue": cValue};
  serverResp.cookie(clientCookie, cValue, {signed: true});                    // send client cookie
  memjs.set(sValue, cValue, function(err, success) {}, ONE_WEEK);             // cache the sessionCookie/clientCookie key/value
      
}

function verifyCookies(clientReq, validCookies, invalidCookies) {
// check the cookies in a HTTP request; callback validCookies when cookies are valid; callback invalidCookies when cookies
// are not valid.
  var sValue = clientReq.signedCookies[sessionCookie];
  var cValue = clientReq.signedCookies[clientCookie];
  if (sValue) {
    if (sessionList[sValue]) {
      if (sessionList[sValue]["cValue"] == cValue) {
        validCookies("From server, got valid session " + sValue + " and client " + cValue + " cookies");
      }
      else {
        invalidCookies("From server, have valid session " + sValue + ", but invalid client " + cValue + " cookies");
      }
    }
    else {
      // server was put to sleep then sessionList does not contain key/value sValue/cValue, so check the memcache
      memjs.get(sValue, on_check_cookie_cache);
    }
  }
  else {
    invalidCookies("From server, no session cookie");
  }

  function on_check_cookie_cache(err, value, key) {
  // callback for the memcache get request for the sessionCookie value sValue; if the sValue is not found, both value and key
  // null; otherwise they are buffers.
    if (key && value && value.toString() == cValue) {
      sessionList[sValue] = {"cValue": cValue};                              // recreate the cookies in sessionList;
      validCookies("From cache, got valid session " + sValue + " and client " + cValue + " cookies");
    }
    else {
      invalidCookies("From cache, no sessionCookie or invalid clientCookie");
    }
  }
}

function debug_log() {
// use debug_log() instead of console.log() to control when logging to console occurs with DEBUG_FLAG.
  DEBUG_FLAG && console.log.apply(console, arguments);
}

function normal_log() {
// use normal_log() instead of console.log() to control when0 logging to console occurs with DEBUG_FLAG.
  !DEBUG_FLAG && console.log.apply(console, arguments);
}
