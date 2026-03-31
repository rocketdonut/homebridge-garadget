/**
 * Homebridge-Garadget
 * @ Index.js Version 0.0.6
 * @ By xNinjasx
 */
var request = require("request");
var mqtt = require("mqtt");

var Service, Characteristic;
module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory("homebridge-garadget-cloudmqtt", "GaradgetCloudMQTT", DoorAccessory);
  }

/**
 * Creates DoorAccessory
 * Sets config
 */
function DoorAccessory(log, config) {
  this.log = log;
  this.name = config["name"];
  this.bypass = config["bypass"];
  this.args = config["args"];

  // MQTT config (local mode)
  this.mqtt_server = config["mqtt_server"] || null;
  this.mqtt_user = config["mqtt_user"] || null;
  this.mqtt_pass = config["mqtt_pass"] || null;
  this.device_name = config["device_name"] || null;
  // How often (seconds) to request a fresh status from the device. Default 60s.
  this.update_interval = (config["update_interval"] || 60) * 1000;
  this.light_sensor = config["light_sensor"] || false;

  // REST/cloud config
  this.cloudURL = config["cloudURL"];
  this.access_token = config["access_token"];
  this.deviceID = config["deviceID"];
  this.particle_username = config["particle_username"] || null;
  this.particle_password = config["particle_password"] || null;

  this.services = [];

  this.informationService = new Service.AccessoryInformation()
    .setCharacteristic(Characteristic.Manufacturer, "Garadget")
    .setCharacteristic(Characteristic.Model, "Photon")
    .setCharacteristic(Characteristic.SerialNumber, "AABBCCDD1");

  if (this.bypass === "1") {
    this.garageservice = new Service.Switch(this.name);
    this.garageservice
      .getCharacteristic(Characteristic.On)
      .on('set', this.setStatebypass.bind(this))
      .on('get', this.getStatebypass.bind(this));
  } else {
    this.garageservice = new Service.GarageDoorOpener(this.name);
    this.garageservice
      .getCharacteristic(Characteristic.CurrentDoorState)
      .on('get', this.getState.bind(this));
    this.garageservice
      .getCharacteristic(Characteristic.TargetDoorState)
      .on('get', this.getState.bind(this))
      .on('set', this.setState.bind(this));
    this.garageservice
      .getCharacteristic(Characteristic.ObstructionDetected)
      .on('get', this.getOD.bind(this));
  }

  // Optional light sensor service (MQTT mode only)
  if (this.light_sensor && this.mqtt_server) {
    this.lightService = new Service.LightSensor(this.name + ' Light');
    this.lightService
      .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .setProps({ minValue: 0.0001 });
  }

  // Start MQTT connection if configured
  if (this.mqtt_server) {
    if (!this.device_name) {
      this.log("ERROR: mqtt_server is set but device_name is missing from config. MQTT will not work.");
    } else {
      this._mqttConnected = false;
      this._cachedState = null; // null = unknown
      this._initMQTT();
    }
  }
}

// ---------------------------------------------------------------------------
// MQTT mode
// ---------------------------------------------------------------------------

DoorAccessory.prototype._initMQTT = function() {
  var self = this;
  var opts = {};
  if (this.mqtt_user) opts.username = this.mqtt_user;
  if (this.mqtt_pass) opts.password = this.mqtt_pass;

  this._statusTopic  = 'garadget/' + this.device_name + '/status';
  this._commandTopic = 'garadget/' + this.device_name + '/command';

  this.log("Connecting to MQTT broker at %s ...", this.mqtt_server);
  this._mqttClient = mqtt.connect(this.mqtt_server, opts);

  this._mqttClient.on('connect', function() {
    self._mqttConnected = true;
    self.log("MQTT connected. Subscribing to %s", self._statusTopic);
    self._mqttClient.subscribe(self._statusTopic, function(err) {
      if (err) {
        self.log("MQTT subscribe error: %s", err);
      } else {
        // Request an immediate status update on connect
        self._mqttClient.publish(self._commandTopic, 'get-status');
        // Then poll on a regular interval
        self._pollTimer = setInterval(function() {
          self._mqttClient.publish(self._commandTopic, 'get-status');
        }, self.update_interval);
      }
    });
  });

  this._mqttClient.on('message', function(topic, message) {
    if (topic !== self._statusTopic) return;
    try {
      var payload = JSON.parse(message.toString());
      var status = payload.status;
      self.log("MQTT status update: %s", status);
      self._cachedState = self._statusToInt(status);
      // Push the new state to HomeKit immediately
      self.garageservice
        .getCharacteristic(Characteristic.CurrentDoorState)
        .updateValue(self._cachedState);
      // Update light sensor if enabled
      if (self.lightService && payload.bright !== undefined) {
        var lux = Math.max(0.0001, payload.bright);
        self.lightService
          .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
          .updateValue(lux);
      }
    } catch (e) {
      self.log("MQTT message parse error: %s", e);
    }
  });

  this._mqttClient.on('offline', function() {
    self._mqttConnected = false;
    self.log("MQTT broker offline.");
  });

  this._mqttClient.on('reconnect', function() {
    self.log("MQTT reconnecting...");
  });

  this._mqttClient.on('error', function(err) {
    self._mqttConnected = false;
    self.log("MQTT error: %s", err);
  });
};

DoorAccessory.prototype._statusToInt = function(status) {
  switch (status) {
    case 'open':     return 0;
    case 'closed':   return 1;
    case 'opening':  return 2;
    case 'closing':  return 3;
    case 'stopped':  return 4;
    default:         return 4; // unknown → stopped
  }
};

// ---------------------------------------------------------------------------
// getState / setState (dispatches to MQTT or REST)
// ---------------------------------------------------------------------------

DoorAccessory.prototype.getState = function(callback) {
  if (this.mqtt_server) {
    this._getStateMQTT(callback);
  } else {
    this._getStateREST(callback);
  }
};

DoorAccessory.prototype.setState = function(state, callback) {
  if (this.mqtt_server) {
    this._setStateMQTT(state, callback);
  } else {
    this._setStateREST(state, callback);
  }
};

DoorAccessory.prototype.getOD = function(callback) {
  if (this.mqtt_server) {
    this._getODMQTT(callback);
  } else {
    this._getODREST(callback);
  }
};

// ---------------------------------------------------------------------------
// MQTT implementations
// ---------------------------------------------------------------------------

DoorAccessory.prototype._getStateMQTT = function(callback) {
  if (this._cachedState !== null) {
    this.log("Getting current state (cached): %s", this._cachedState);
    callback(null, this._cachedState);
  } else if (!this._mqttConnected) {
    this.log("MQTT not connected, state unknown.");
    callback(new Error("MQTT not connected"));
  } else {
    // Connected but no status received yet — request one and wait briefly
    var self = this;
    this._mqttClient.publish(this._commandTopic, 'get-status');
    var waited = 0;
    var interval = setInterval(function() {
      waited += 250;
      if (self._cachedState !== null) {
        clearInterval(interval);
        callback(null, self._cachedState);
      } else if (waited >= 5000) {
        clearInterval(interval);
        callback(new Error("Timed out waiting for MQTT status"));
      }
    }, 250);
  }
};

DoorAccessory.prototype._setStateMQTT = function(state, callback) {
  if (!this._mqttConnected) {
    callback(new Error("MQTT not connected"));
    return;
  }
  var command;
  switch (state) {
    case 0: command = 'open';  break;
    case 1: command = 'close'; break;
    default: command = 'stop'; break;
  }
  this.log("Publishing MQTT command: %s", command);
  this._mqttClient.publish(this._commandTopic, command, function(err) {
    if (err) {
      callback(err);
    } else {
      callback(null);
    }
  });
};

DoorAccessory.prototype._getODMQTT = function(callback) {
  // ObstructionDetected = YES if MQTT broker is unreachable
  callback(null, this._mqttConnected ? 0 : 1);
};

// ---------------------------------------------------------------------------
// REST implementations (unchanged from previous version)
// ---------------------------------------------------------------------------

DoorAccessory.prototype._getStateREST = function(callback) {
    this.log("Getting current state...");
    var url = this.cloudURL + this.deviceID + '/doorStatus?access_token=' + this.access_token;

    this.getWithRetry(url, 3, function(err, body) {
      if (!err) {
        var json = JSON.parse(body);
        var currentState = DoorAccessory.prototype.parseStatus(json.result);
        this.log("Door state is %s", currentState);
        callback(null, this._statusToInt(currentState));
      } else {
        this.log("Error getting state: %s", err);
        callback(err);
      }
    }.bind(this));
  }

DoorAccessory.prototype._setStateREST = function(state, callback) {
    this.log("state = ", state);
    var doorState;
    switch (state) {
      case 0: doorState = 'open';   break;
      case 1: doorState = 'closed'; break;
      default: doorState = 'stop';  break;
    };
    this.log("Set state to %s", doorState);
    request.post({
      url: this.cloudURL + this.deviceID + '/setState',
      form: {
        access_token: this.access_token,
        args: doorState
      }
    }, function(err, response, body) {
      if (!err && response.statusCode == 200) {
        this.log("State change complete.");
        var currentState = (state == Characteristic.TargetDoorState.CLOSED) ? Characteristic.CurrentDoorState.CLOSED : Characteristic.CurrentDoorState.OPEN;
        this.garageservice.setCharacteristic(Characteristic.CurrentDoorState, currentState);
        callback(null);
      } else if (response && response.statusCode == 401) {
        this.log("Received 401 Unauthorized when setting state. Attempting token refresh...");
        this.refreshToken(function(refreshErr) {
          if (!refreshErr) {
            request.post({
              url: this.cloudURL + this.deviceID + '/setState',
              form: { access_token: this.access_token, args: doorState }
            }, function(err2, response2) {
              if (!err2 && response2.statusCode == 200) {
                this.log("State change complete after token refresh.");
                var currentState = (state == Characteristic.TargetDoorState.CLOSED) ? Characteristic.CurrentDoorState.CLOSED : Characteristic.CurrentDoorState.OPEN;
                this.garageservice.setCharacteristic(Characteristic.CurrentDoorState, currentState);
                callback(null);
              } else {
                callback(err2 || new Error("Error setting door state."));
              }
            }.bind(this));
          } else {
            callback(new Error("Token expired and could not be refreshed."));
          }
        }.bind(this));
      } else {
        this.log("Error '%s' setting door state. Response: %s", err, body);
        callback(err || new Error("Error setting door state."));
      }
    }.bind(this));
  }

DoorAccessory.prototype._getODREST = function(callback) {
    this.log("Get ObstructionDetected...");
    var url = this.cloudURL + this.deviceID + '/doorStatus?access_token=' + this.access_token;

    this.getWithRetry(url, 2, function(err) {
      if (!err) {
        this.log("Access Key good...");
        callback(null, 0);
      } else {
        if (err.message && err.message.indexOf("Token expired") !== -1) {
          this.log("Access token has expired. Add particle_username and particle_password to config.json for automatic refresh, or update access_token manually.");
          callback(null, 1);
        } else {
          this.log("Transient error checking access token (not a token expiry): %s", err);
          callback(null, 0);
        }
      }
    }.bind(this));
  }

// ---------------------------------------------------------------------------
// Bypass (REST only — MQTT bypass mode not commonly needed)
// ---------------------------------------------------------------------------

DoorAccessory.prototype.getStatebypass = function(callback) {
    this.log("Getting current state...");
    var url = this.cloudURL + this.deviceID + '/doorStatus?access_token=' + this.access_token;

    this.getWithRetry(url, 3, function(err, body) {
      if (!err) {
        var json = JSON.parse(body);
        var state = DoorAccessory.prototype.parseStatus(json.result);
        this.log("Bypass state is %s", state);
        var bypassState = (state === 'open') ? 1 : 0;
        this.log("bypassState = %s", bypassState);
        callback(null, bypassState);
      } else {
        this.log("Error getting bypass state: %s", err);
        callback(err);
      }
    }.bind(this));
  }

DoorAccessory.prototype.setStatebypass = function(state, callback) {
    this.log("state = ", state);
    var doorState = this.args.replace("{STATE}", (state ? "open" : "closed"));
    this.log("Set bypass state to %s", doorState);
    request.post({
      url: this.cloudURL + this.deviceID + '/setState',
      form: { access_token: this.access_token, args: doorState }
    }, function(err, response, body) {
      if (!err && response.statusCode == 200) {
        this.log("State bypass change complete.");
        callback(null);
      } else {
        this.log("Error '%s' setting bypass state. Response: %s", err, body);
        callback(err || new Error("Error setting bypass state."));
      }
    }.bind(this));
  }

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

/**
 * GET with retry and automatic token refresh on 401.
 */
DoorAccessory.prototype.getWithRetry = function(url, maxRetries, callback) {
  var self = this;
  var attempt = 0;

  function tryRequest() {
    request.get({ url: url }, function(err, response, body) {
      if (!err && response.statusCode == 200) {
        callback(null, body);
        return;
      }

      if (response && response.statusCode == 401) {
        self.log("Received 401 Unauthorized. Access token may be expired.");
        self.refreshToken(function(refreshErr) {
          if (!refreshErr) {
            var refreshedUrl = url.replace(/access_token=[^&]+/, 'access_token=' + self.access_token);
            request.get({ url: refreshedUrl }, function(err2, response2, body2) {
              if (!err2 && response2.statusCode == 200) {
                callback(null, body2);
              } else {
                callback(err2 || new Error("Request failed after token refresh (status " + (response2 && response2.statusCode) + ")"));
              }
            });
          } else {
            self.log("Token refresh failed. Update access_token manually in config.json.");
            callback(new Error("Token expired and could not be refreshed automatically."));
          }
        });
        return;
      }

      attempt++;
      if (attempt <= maxRetries) {
        var delay = Math.pow(2, attempt - 1) * 1000;
        self.log("Request failed (attempt %s/%s), retrying in %sms: %s", attempt, maxRetries, delay, err || ("status " + (response && response.statusCode)));
        setTimeout(tryRequest, delay);
      } else {
        callback(err || new Error("Request failed after " + maxRetries + " retries (status " + (response && response.statusCode) + ")"));
      }
    });
  }

  tryRequest();
};

DoorAccessory.prototype.refreshToken = function(callback) {
  if (!this.particle_username || !this.particle_password) {
    callback(new Error("No Particle credentials configured for token refresh."));
    return;
  }
  this.log("Attempting to refresh Particle access token...");
  request.post({
    url: 'https://api.particle.io/oauth/token',
    form: {
      grant_type: 'password',
      username: this.particle_username,
      password: this.particle_password,
      client_id: 'particle',
      client_secret: 'particle'
    }
  }, function(err, response, body) {
    if (!err && response.statusCode == 200) {
      this.access_token = JSON.parse(body).access_token;
      this.log("Access token refreshed successfully.");
      callback(null);
    } else {
      callback(new Error("Failed to refresh token."));
    }
  }.bind(this));
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

DoorAccessory.prototype.getServices = function() {
    var services = [this.garageservice];
    if (this.lightService) services.push(this.lightService);
    return services;
  }

DoorAccessory.prototype.parseStatus = function(p_status) {
  var split1 = p_status.split("|");
  var split2 = split1[0].split("=");
  return split2[1];
}
