'use strict'
const _ = require('lodash');
const url = require('url');
const moesifapi = require('moesifapi');
const requestIp = require('request-ip');
const moesifConfigManager = require('./moesifConfigManager');
const EventModel = moesifapi.EventModel;
const UserModel = moesifapi.UserModel;
const CompanyModel = moesifapi.CompanyModel;
var startTime = Date.now();

//
// ### function moesifExpress(options)
// #### @options {Object} options to initialize the middleware.
//

var logMessage = function(debug, functionName, message) {
  if (debug) {
    console.log('MOESIF: [' + functionName + '] ' + message);
  }
};

module.exports = function (options, handler) {

  logMessage(options.debug, 'moesifInitiator', 'start');

  options.applicationId = options.applicationId || process.env.MOESIF_APPLICATION_ID;

  options.identifyUser = options.identifyUser || function (event, context) {
      return (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.principalId) ||
          event.principalId ||

          (event.requestContext && event.requestContext.identity && event.requestContext.identity.cognitoIdentityId) ||
          (context.identity && context.identity.cognitoIdentityId) ||

          (event.requestContext && event.requestContext.identity && event.requestContext.identity.user) ||
          event.user;
    };

  options.identifyCompany = options.identifyCompany || function() {};

  options.getSessionToken = options.getSessionToken || function (event, context) {
      return (event.requestContext && event.requestContext.identity && event.requestContext.identity.apiKey);
    };
  options.getMetadata = options.getMetadata || function (event, context) {
    const metadata = {};
    metadata.trace_id = context.awsRequestId;
    metadata.function_name = context.functionName;
    metadata.request_context = event && event.requestContext;
    return metadata;
  };
  options.getTags = options.getTags || function () {
      return undefined;
    };
  options.getApiVersion = options.getApiVersion || function (event, context) {
      return context.functionVersion;
    };
  options.maskContent = options.maskContent || function (eventData) {
      return eventData;
    };
  options.ignoreRoute = options.ignoreRoute || function () {
      return false;
    };
  options.skip = options.skip || function () {
      return false;
    };

  var logBody = true;
  if (typeof options.logBody !== 'undefined' && options.logBody !== null) {
      logBody = Boolean(options.logBody);
   }
  options.logBody = logBody;

  ensureValidOptions(options);

  // config moesifapi
  var config = moesifapi.configuration;
  config.ApplicationId = options.applicationId || options.ApplicationId || process.env.MOESIF_APPLICATION_ID;
  config.BaseUri = options.baseUri || options.BaseUri || config.BaseUri;
  var moesifController = moesifapi.ApiController;

  var moesifMiddleware = function (event, context, callback) {
    logMessage(options.debug, 'moesifMiddleware', 'start');
    moesifConfigManager.tryGetConfig();

    var next = function (err, result) {
      logEvent(event, context, err, result, options, moesifController);
      callback(err, result)
    };

    handler(event, context, next);
  };

  moesifMiddleware.updateUser = function(userModel, cb) {
    const user = new UserModel(userModel);
    logMessage(options.debug, 'updateUser', 'userModel=' + JSON.stringify(userModel));
    ensureValidUserModel(user);
    logMessage(options.debug, 'updateUser', 'userModel valid');
    moesifController.updateUser(user, cb);
  };

  moesifMiddleware.updateUsersBatch = function(usersBatchModel, cb) {
    usersBatch = [];
    for (let userModel of usersBatchModel) {
      usersBatch.push(new UserModel(userModel));
    }
    logMessage(options.debug, 'updateUsersBatch', 'usersBatchModel=' + JSON.stringify(usersBatchModel));
    ensureValidUsersBatchModel(usersBatch);
    logMessage(options.debug, 'updateUsersBatch', 'usersBatchModel valid');
    moesifController.updateUsersBatch(usersBatch, cb);
  };

  moesifMiddleware.updateCompany = function(companyModel, cb) {
    const company = new CompanyModel(companyModel);
    logMessage(options.debug, 'updateCompany', 'companyModel=' + JSON.stringify(companyModel));
    ensureValidCompanyModel(company);
    logMessage(options.debug, 'updateCompany', 'companyModel valid');
    moesifController.updateCompany(company, cb);
  }

  moesifMiddleware.updateCompaniesBatch = function(companiesBatchModel, cb) {
    companiesBatch = [];
    for (let companyModel of companiesBatchModel) {
      companiesBatch.push(new CompanyModel(companyModel));
    }
    logMessage(options.debug, 'updateCompaniesBatch', 'companiesBatchModel=' + JSON.stringify(companiesBatchModel));
    ensureValidCompaniesBatchModel(companiesBatch);
    logMessage(options.debug, 'updateCompaniesBatch', 'companiesBatchModel valid');
    moesifController.updateCompaniesBatch(companiesBatch, cb);
  };

  logMessage(options.debug, 'moesifInitiator', 'returning moesifMiddleware Function');
  return moesifMiddleware;
};

function mapResponseHeaders(event, context, result) {
    const headers = result.headers || {}; // NOTE: Mutating event.headers; prefer deep clone of event.headers
    return headers;
}

function logEvent(event, context, err, result, options, moesifController) {

  if (!event.httpMethod || !event.headers) {
      logMessage(options.debug, 'logEvent', 'Expecting input format to be the API Gateway proxy integration type. ' +
          'See https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-set-up-simple-proxy.html#api-gateway-set-up-lambda-proxy-integration-on-proxy-resource');
      return;
  }

  var logData = {};
  logData.request = {};
  logData.response = {};
  logData.request.time = event && event.requestContext && event.requestContext.requestTimeEpoch ? 
    new Date(event && event.requestContext && event.requestContext.requestTimeEpoch) : 
    startTime;

  logData.request.uri = getURLWithQueryStringParams(event);
  logData.request.verb = event.httpMethod;
  logData.request.apiVerion = options.getApiVersion(event, context);
  logData.request.ipAddress = requestIp.getClientIp(event) || (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp);
  logData.request.headers = event.headers || {};
  logData.metadata = options.getMetadata(event, context);

  if (options.logBody && event.body) {
      if (event.isBase64Encoded) {
        logData.request.body = event.body;
        logData.request.transferEncoding = 'base64';
      } else {
        const bodyWrapper = safeJsonParse(event.body);
        logData.request.body = bodyWrapper.body
        logData.request.transferEncoding = bodyWrapper.transferEncoding
      }
  }

  logMessage(options.debug, 'logEvent', 'created request: \n' + JSON.stringify(logData.request));
  var safeRes = result || {};
  logData.response.time = Math.max(new Date(logData.request.time).getTime(), Date.now());
  logData.response.status = safeRes.statusCode ? parseInt(safeRes.statusCode) : 599;
  logData.response.headers = mapResponseHeaders(event, context, safeRes);

  if (options.logBody && safeRes.body) {
      if (safeRes.isBase64Encoded) {
        logData.response.body = safeRes.body;
        logData.response.transferEncoding = 'base64';
      } else {
        const bodyWrapper = safeJsonParse(safeRes.body);
        logData.response.body = bodyWrapper.body
        logData.response.transferEncoding = bodyWrapper.transferEncoding
      }
  }

  logMessage(options.debug, 'logEvent', 'created data: \n' + JSON.stringify(logData));

  logData = options.maskContent(logData);

  logData.userId = options.identifyUser(event, context);
  logData.companyId = options.identifyCompany(event, context);
  logData.sessionToken = options.getSessionToken(event, context);
  logData.tags = options.getTags(event, context);

  // Set API direction
  logData.direction = "Incoming"

  logMessage(options.debug, 'logEvent', 'applied options to data: \n' + JSON.stringify(logData));

  ensureValidLogData(logData);

  // This is fire and forget, we don't want logging to hold up the request so don't wait for the callback
  if (!options.skip(event, context) && moesifConfigManager.shouldSend(logData && logData.userId, logData && logData.companyId)) {

    let sampleRate = moesifConfigManager._getSampleRate(logData && logData.userId, logData && logData.companyId);
    logData.weight = sampleRate === 0 ? 1 : Math.floor(100 / sampleRate);

    logMessage(options.debug, 'logEvent', 'sending data invoking moesifAPI');

    moesifController.createEvent(new EventModel(logData), function(err) {
      if (err) {
        logMessage(options.debug, 'logEvent', 'Moesif API failed with err=' + JSON.stringify(err));
        if (options.callback) {
          options.callback(err, logData);
        }
      } else {
        logMessage(options.debug, 'logEvent', 'Moesif API succeeded');
        if(options.callback) {
          options.callback(null, logData);
        }
      }
    });
  }
}

function bodyToBase64(body) {
  if(!body) {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString('base64');
  } else if (typeof body === 'string') {
    return Buffer.from(body).toString('base64');
  } else if (typeof body.toString === 'function') {
    return Buffer.from(body.toString()).toString('base64');
  } else {
    return '';
  }
}

function safeJsonParse(body) {
  try {
    if (!Buffer.isBuffer(body) &&
      (typeof body === 'object' || Array.isArray(body))) {
      return {
        body: body,
        transferEncoding: undefined
      }
    }
    return {
      body: JSON.parse(body.toString()),
      transferEncoding: undefined
    }
  } catch (e) {
    return {
      body: bodyToBase64(body),
      transferEncoding: 'base64'
    }
  }
}

function bodyToBase64(body) {
  if (!body) {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString('base64');
  } else if (typeof body === 'string') {
    return Buffer.from(body).toString('base64');
  } else if (typeof body.toString === 'function') {
    return Buffer.from(body.toString()).toString('base64');
  } else {
    return '';
  }
}

function getURLWithQueryStringParams(event) {
  try {
    var protocol = (event.headers && event.headers['X-Forwarded-Proto'] || event.headers['x-forwarded-proto']) ? (event.headers['X-Forwarded-Proto'] || event.headers['x-forwarded-proto']) : 'http';
    var host = event.headers.Host || event.headers.host;
    return url.format({ protocol: protocol, host: host, pathname: event.path, query: event.queryStringParameters });
  } catch (err) {
    return '/';
  }
}

function ensureValidOptions(options) {
  if (!options) throw new Error('options are required by moesif-express middleware');
  if (!options.applicationId) throw new Error('A Moesif application id is required. Please obtain it through your settings at www.moesif.com');
  if (options.identifyUser && !_.isFunction(options.identifyUser)) {
    throw new Error('identifyUser should be a function');
  }
  if (options.identifyCompany && !_.isFunction(options.identifyCompany)) {
    throw new Error('identifyCompany should be a function');
  }
  if (options.getSessionToken && !_.isFunction(options.getSessionToken)) {
    throw new Error('getSessionToken should be a function');
  }
  if (options.getMetadata && !_.isFunction(options.getMetadata)) {
    throw new Error('getMetadata should be a function');
  }
  if (options.getTags && !_.isFunction(options.getTags)) {
    throw new Error('getTags should be a function');
  }
  if (options.getApiVersion && !_.isFunction(options.getApiVersion)) {
    throw new Error('getApiVersion should be a function');
  }
  if (options.maskContent && !_.isFunction(options.maskContent)) {
    throw new Error('maskContent should be a function');
  }
  if (options.skip && !_.isFunction(options.skip)) {
    throw new Error('skip should be a function');
  }
}

function ensureValidLogData(logData) {
  if (!logData.request) {
    throw new Error('For Moesif events, request and response objects are required. Please check your maskContent function do not remove this');
  }
  else {
    if (!logData.request.time) {
      throw new Error('For Moesif events, request time is required. Please check your maskContent function do not remove this');
    }
    if (!logData.request.verb) {
      throw new Error('For Moesif events, request verb is required. Please check your maskContent function do not remove this');
    }
    if (!logData.request.uri) {
      throw new Error('For Moesif events, request uri is required. Please check your maskContent function do not remove this');
    }
  }
  if (!logData.response) {
    throw new Error('For Moesif events, request and response objects are required. Please check your maskContent function do not remove this');
  }
  else {
    if (!logData.request.time) {
      throw new Error('For Moesif events, response time is required. The middleware should populate it automatically. Please check your maskContent function do not remove this');
    }
  }
}

function ensureValidUserModel(userModel) {
  if (!userModel || !userModel.userId) {
    throw new Error('To update user, a userId field is required');
  }
}

function ensureValidCompanyModel(companyModel) {
  if (!companyModel || !companyModel.companyId) {
    throw new Error('To update company, a companyId field is required');
  }
}
