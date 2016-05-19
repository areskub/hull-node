import MessageValidator from 'sns-validator';
import connect from 'connect';
import https from 'https';
import _ from 'lodash';
import Client from './client';
import rawBody from 'raw-body';
import {group} from './trait';

function parseRequest() {
  return function(req, res, next) {
    req.hull = req.hull || {};
    rawBody(req, true, (err, body) => {
      if (err) {
        return res.handleError('Invalid body', 400);
      }
      try {
        req.hull.message = JSON.parse(body);
      } catch (parseError) {
        return res.handleError('Invalid body', 400);
      }
      return next();
    });
  };
}

function verifySignature(options = {}) {
  const validator = new MessageValidator(/sns\.us-east-1\.amazonaws\.com/, 'utf8');

  return function(req, res, next) {
    if (!req.hull.message) {
      return res.handleError('Empty Message', 400);
    }

    validator.validate(req.hull.message, function(err) {
      if (err) {
        if (options.enforceValidation) {
          return res.handleError(err.toString(), 400);
        }
        console.warn('Invalid signature error', req.hull.message);
      }

      const { message } = req.hull;

      if (message.Type === 'SubscriptionConfirmation') {
        https.get(message.SubscribeURL, () => {
          if (typeof options.onSubscribe === 'function') {
            options.onSubscribe(req);
          }
          return res.end('subscribed');
        }, () => {
          return res.handleError('Failed to subscribe', 400);
        });
      } else if (message.Type === 'Notification') {
        try {
          const payload = JSON.parse(message.Message);
          if (payload && payload.user && options.groupTraits) {
            payload.user = group(payload.user);
          }

          req.hull.notification = {
            subject: message.Subject,
            message: payload,
            timestamp: new Date(message.Timestamp)
          };
          next();
        } catch (error) {
          res.handleError('Invalid message', 400);
        }
      }
    });
  };
}

function processHandlers(handlers) {
  return function(req, res, next) {
    try {
      const { message, notification, client, ship } = req.hull;
      const eventName = getHandlerName(message.Subject);
      const messageHandlers = handlers[eventName];
      const processing = [];

      const context = {
        req, ship,
        hull: client
      };

      if (messageHandlers && messageHandlers.length > 0) {
        messageHandlers.map(fn => {
          processing.push(fn(notification, context));
        });
      }

      const eventHandlers = handlers['event'] || [];

      if (eventHandlers.length > 0 && eventName === 'user:update' && notification.message) {
        const { user, events=[], segments = [] } = notification.message;
        if (events.length > 0) {
          events.map(event => {
            eventHandlers.map(fn => {
              const payload = {
                message: { user, segments, event },
                subject: 'event',
                timestamp: message.Timestamp
              };
              processing.push(fn(payload, context))
            })
          })
        }
      }

      if (processing.length > 0) {
        Promise.all(processing).then(() => {
          next();
        }, (err) => {
          res.handleError(err.toString(), err.status || 400);
        });
      } else {
        next();
      }
    } catch ( err ) {
      res.handleError(err.toString(), 500);
    }
  };
}


function enrichWithHullClient() {
  var _cache = [];

  function getCurrentShip(shipId, client, forceUpdate) {
    if (forceUpdate) _cache[shipId] = null;
    _cache[shipId] = _cache[shipId] || client.get(shipId);
    return _cache[shipId];
  }

  return function(req, res, next) {
    const config = ['organization', 'ship', 'secret'].reduce((cfg, k)=> {
      const val = req.query[k];
      if (typeof val === 'string') {
        cfg[k] = val;
      } else if (val && val.length) {
        cfg[k] = val[0];
      }

      if (typeof cfg[k] === 'string') {
        cfg[k] = cfg[k].trim();
      }

      return cfg;
    }, {});

    req.hull = req.hull || {};

    const { message } = req.hull;
    let forceShipUpdate = false;
    if (message && message.Subject === 'ship:update') {
      forceShipUpdate = true;
    }

    if (config.organization && config.ship && config.secret) {
      const client = req.hull.client = new Client({
        organization: config.organization,
        id: config.ship,
        secret: config.secret
      });
      getCurrentShip(config.ship, client, forceShipUpdate).then((ship) => {
        req.hull.ship = ship;
        next();
      }, (err) => {
        res.handleError(err.toString(), 400);
      });
    } else {
      next();
    }
  };
}

function errorHandler(onError) {
  return function(req, res, next) {
    res.handleError = function(message, status) {
      if (onError) onError(message, status);
      res.status(status);
      res.end(message);
    };
    next();
  };
}

function getHandlerName(eventName) {
  const ModelsMapping = {
    'user_report': 'user',
    'users_segment': 'segment'
  }
  const [ modelName, action ] = eventName.split(':');
  const model = ModelsMapping[modelName] || modelName;
  return _.compact([model, action]).join(':');
}

module.exports = function NotifHandler(options = {}) {
  const _handlers = {};
  const app = connect();

  function addEventHandler(evt, fn) {
    const eventName = getHandlerName(evt);
    _handlers[eventName] = _handlers[eventName] || [];
    _handlers[eventName].push(fn);
    return this;
  }

  function addEventHandlers(eventsHash) {
    _.map(eventsHash, (fn, eventName) => addEventHandler(eventName, fn));
    return this;
  }

  if (options.handlers) {
    addEventHandlers(options.handlers);
  }

  app.use(errorHandler(options.onError));
  app.use(parseRequest());
  app.use(verifySignature({
    onSubscribe: options.onSubscribe,
    enforceValidation: false,
    groupTraits: options.groupTraits !== false
  }));
  app.use(enrichWithHullClient());
  app.use(processHandlers(_handlers));
  app.use((req, res) => { res.end('ok'); });

  function handler(req, res) {
    return app.handle(req, res);
  }

  handler.addEventHandler = addEventHandler;

  return handler;
};
