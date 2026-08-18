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

  // Mode can be set explicitly via schema form, or inferred from presence of mqtt_server
  var mode = config["mode"] || (config["mqtt_server"] ? "mqtt" : "cloud");

  // MQTT config (local mode)
  this.mqtt_server = mode === "mqtt" ? (config["mqtt_server"] || null) : null;
  this.mqtt_user = config["mqtt_user"] || null;
  this.mqtt_pass = config["mqtt_pass"] || null;
  this.device_name = config["device_name"] || null;
  // How often (seconds) to request a fresh status from the device. Default 60s.
  this.update_interval = (config["update_interval"] || 60) * 1000;
  this.light_sensor = config["light_sensor"] || false;
  // Hold a closed->opening report this long (seconds) before telling HomeKit.
  // Filters out single-scan sensor glitches (bug on the lens, bad read) that
  // show up as closed -> opening -> closed within a couple of seconds.
  // Set to 0 to disable. Default 3 seconds.
  this._blipFilterMs = (config["blip_filter"] !== undefined ? config["blip_filter"] : 3) * 1000;

  // REST/cloud config
  this.cloudURL = config["cloudURL"];
  this.access_token = config["access_token"];
  this.deviceID = config["deviceID"];
  this.particle_username = config["particle_username"] || null;
  this.particle_password = config["particle_password"] || null;

  this.services = [];
  this._serialNumber = "Unknown";
  this._firmwareRevision = "Unknown";

  var self = this;
  this.informationService = new Service.AccessoryInformation()
    .setCharacteristic(Characteristic.Manufacturer, "Garadget")
    .setCharacteristic(Characteristic.Model, "Photon");
  this.informationService
    .getCharacteristic(Characteristic.SerialNumber)
    .on('get', function(callback) { callback(null, self._serialNumber); });
  this.informationService
    .getCharacteristic(Characteristic.FirmwareRevision)
    .on('get', function(callback) { callback(null, self._firmwareRevision); });

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
      .on('get', this.getTargetState.bind(this))
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
      this._targetState = 1;    // assume closed until first status arrives
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
  this._configTopic  = 'garadget/' + this.device_name + '/config';

  this.log("Connecting to MQTT broker at %s ...", this.mqtt_server);
  this._mqttClient = mqtt.connect(this.mqtt_server, opts);

  this._mqttClient.on('connect', function() {
    self._mqttConnected = true;
    self.log("MQTT connected. Subscribing to %s", self._statusTopic);
    self._mqttClient.subscribe([self._statusTopic, self._configTopic], function(err) {
      if (err) {
        self.log("MQTT subscribe error: %s", err);
      } else {
        // Request immediate status and config on connect
        self._mqttClient.publish(self._commandTopic, 'get-status');
        self._mqttClient.publish(self._commandTopic, 'get-config');
        // Then poll status on a regular interval
        self._pollTimer = setInterval(function() {
          self._mqttClient.publish(self._commandTopic, 'get-status');
        }, self.update_interval);
      }
    });
  });

  this._mqttClient.on('message', function(topic, message) {
    try {
      var payload = JSON.parse(message.toString());
    } catch (e) {
      self.log("MQTT message parse error: %s", e);
      return;
    }

    // Update HomeKit accessory info from device config payload
    if (topic === self._configTopic) {
      if (payload.ver) self._firmwareRevision = payload.ver;
      if (payload.id) self._serialNumber = payload.id;
      return;
    }

    if (topic !== self._statusTopic) return;
    var status = payload.status;
    self.log("MQTT status update: %s", status);
    var newState = self._statusToInt(status);

    if (self._blipTimer) {
      // A closed->opening report is on hold. Whatever arrives next decides:
      // "closed" again means it was a sensor blip, drop it silently;
      // anything else means the door really is moving, apply it now.
      clearTimeout(self._blipTimer);
      self._blipTimer = null;
      if (newState === 1) {
        self.log("Suppressed sensor blip (door reported closed again within the hold window).");
      }
    } else if (self._blipFilterMs > 0 && self._cachedState === 1 && (newState === 2 || newState === 0)) {
      self.log("Door reports %s while closed; holding %sms to rule out a sensor blip...", status, self._blipFilterMs);
      self._blipTimer = setTimeout(function() {
        self._blipTimer = null;
        self._applyStatus(status);
      }, self._blipFilterMs);
      return;
    }

    self._applyStatus(status);
    // Update light sensor if enabled
    if (self.lightService && payload.bright !== undefined) {
      var lux = Math.max(0.0001, payload.bright);
      self.lightService
        .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
        .updateValue(lux);
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

DoorAccessory.prototype._applyStatus = function(status) {
  this._cachedState = this._statusToInt(status);
  // Keep TargetDoorState in sync so HomeKit doesn't think a command is
  // still pending (a stale target can cause the Home app to re-send
  // commands, which pulses the relay again and stops the door mid-travel).
  if (status === 'open' || status === 'opening') {
    this._targetState = 0;
  } else if (status === 'closed' || status === 'closing') {
    this._targetState = 1;
  } else if (status === 'stopped') {
    // Door is stuck mid-travel. After a failed close the stored target is
    // still "closed", so another close tap in the Home app writes the same
    // target value and iOS never delivers it -- the door becomes
    // uncontrollable from HomeKit while other apps still work. Pointing the
    // target at "open" makes the next close tap a real change again.
    this._targetState = 0;
  }
  this.garageservice
    .getCharacteristic(Characteristic.TargetDoorState)
    .updateValue(this._targetState);
  this.garageservice
    .getCharacteristic(Characteristic.CurrentDoorState)
    .updateValue(this._cachedState);
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

DoorAccessory.prototype.getTargetState = function(callback) {
  if (this.mqtt_server) {
    // TargetDoorState only accepts OPEN (0) or CLOSED (1). Never return
    // transitional values like opening/closing here.
    callback(null, this._targetState);
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

  // Ignore redundant commands. Every command pulses the opener's relay, and
  // a pulse while the door is moving stops it dead. If the door is already
  // moving toward (or already at) the requested state, do nothing.
  var current = this._cachedState;
  if (state === 1 && (current === 1 || current === 3)) {
    this.log("Ignoring close command: door is already %s.", current === 1 ? "closed" : "closing");
    this._targetState = 1;
    callback(null);
    return;
  }
  if (state === 0 && (current === 0 || current === 2)) {
    this.log("Ignoring open command: door is already %s.", current === 0 ? "open" : "opening");
    this._targetState = 0;
    callback(null);
    return;
  }

  var command;
  switch (state) {
    case 0: command = 'open';  break;
    case 1: command = 'close'; break;
    default: command = 'stop'; break;
  }
  this._targetState = (state === 0) ? 0 : 1;
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
    var services = [this.informationService, this.garageservice];
    if (this.lightService) services.push(this.lightService);
    return services;
  }

DoorAccessory.prototype.parseStatus = function(p_status) {
  var split1 = p_status.split("|");
  var split2 = split1[0].split("=");
  return split2[1];
}
