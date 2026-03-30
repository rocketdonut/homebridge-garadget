/**
 * Homebridge-Garadget
 * @ Index.js Version 0.0.5
 * @ By xNinjasx
 */
//sets get json dependent
var request = require("request");

//sets homebridge
var Service, Characteristic;
module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory("homebridge-garadget", "Garadget", DoorAccessory);
  }
/**
 * Creates DoorAccessory
 * Sets config
 */
function DoorAccessory(log, config) {
  this.log = log; // Debug log
  this.name = config["name"]; // Name that shows up in homekit app
  this.cloudURL = config["cloudURL"]; // Grabs the Particle cloud url
  this.access_token = config["access_token"]; // Grabs your token for deviceID
  this.deviceID = config["deviceID"]; // Grabs your deviceID
  this.bypass = config["bypass"]; // Bypass trigger
  this.args = config["args"]; // For the bypass onoff state
  // Optional: Particle credentials for automatic token refresh
  this.particle_username = config["particle_username"] || null;
  this.particle_password = config["particle_password"] || null;
  this.services = [];
  //Suppose to set information about Accessory
  this.informationService = new Service.AccessoryInformation()
    .setCharacteristic(Characteristic.Manufacturer, "Garadget")
    .setCharacteristic(Characteristic.Model, "Photon")
    .setCharacteristic(Characteristic.SerialNumber, "AABBCCDD1");
  //Checking for bypass
  if (this.bypass === "1") {
    this.garageservice = new Service.Switch(this.name); // Makes Switch Service - you can change "Switch" to "Lightbulb"
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
}
/**
 * Refreshes the Particle Cloud access token using username/password credentials.
 * Calls back with (err) — on success, this.access_token is updated in memory.
 */
DoorAccessory.prototype.refreshToken = function(callback) {
  if (!this.particle_username || !this.particle_password) {
    callback(new Error("No Particle credentials configured for token refresh. Add particle_username and particle_password to config.json."));
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
      var json = JSON.parse(body);
      this.access_token = json.access_token;
      this.log("Access token refreshed successfully.");
      callback(null);
    } else {
      var msg = "Failed to refresh token. Check your particle_username and particle_password in config.json.";
      this.log(msg);
      callback(new Error(msg));
    }
  }.bind(this));
};
/**
 * Makes a GET request with automatic retry on transient errors.
 * Retries up to maxRetries times with exponential backoff.
 * If a 401 is received and credentials are available, attempts a token refresh before retrying.
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

      // Token expired — try to refresh and retry once
      if (response && response.statusCode == 401) {
        self.log("Received 401 Unauthorized. Access token may be expired.");
        self.refreshToken(function(refreshErr) {
          if (!refreshErr) {
            // Retry once with updated token in the URL — rebuild URL with new token
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

      // Transient error — retry with backoff
      attempt++;
      if (attempt <= maxRetries) {
        var delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        self.log("Request failed (attempt %s/%s), retrying in %sms: %s", attempt, maxRetries, delay, err || ("status " + (response && response.statusCode)));
        setTimeout(tryRequest, delay);
      } else {
        callback(err || new Error("Request failed after " + maxRetries + " retries (status " + (response && response.statusCode) + ")"));
      }
    });
  }

  tryRequest();
};
/**
 * Gets Status of the Garadget
 */
DoorAccessory.prototype.getState = function(callback) {
    this.log("Getting current state...");
    var url = this.cloudURL + this.deviceID + '/doorStatus?access_token=' + this.access_token;

    this.getWithRetry(url, 3, function(err, body) {
      if (!err) {
        var json = JSON.parse(body);
        var currentState = DoorAccessory.prototype.parseStatus(json.result);
        this.log("Door state is %s", currentState);
        switch (currentState) {
		case 'open':
        var currentState = 0;
        break;
		case 'closed':
        var currentState = 1;
        break;
		case 'opening':
        var currentState = 2;
        break;
		case 'closing':
        var currentState = 3;
        break;
		case 'stopped':
        var currentState = 4;
        break;
		};
		callback(null, currentState); // success
      } else {
        this.log("Error getting state: %s", err);
        callback(err);
      }
    }.bind(this));
  }
/**
 * Gets Status of the Garadget for bypass trigger
 */
DoorAccessory.prototype.getStatebypass = function(callback) {
    this.log("Getting current state...");
    var url = this.cloudURL + this.deviceID + '/doorStatus?access_token=' + this.access_token;

    this.getWithRetry(url, 3, function(err, body) {
      if (!err) {
        var json = JSON.parse(body);
        var state = DoorAccessory.prototype.parseStatus(json.result);
        this.log("Bypass state is %s", state);
        switch (state) {
		case 'open':
        var bypassState = 1;
        break;
		case 'closed':
        var bypassState = 0;
        break;
		};
		this.log("bypassState = %s", bypassState);
        callback(null, bypassState); // success
      } else {
        this.log("Error getting bypass state: %s", err);
        callback(err);
      }
    }.bind(this));
  }
/**
 * Sets Status of the Garadget
 */
DoorAccessory.prototype.setState = function(state, callback) {
    this.log("state = ", state);
    switch (state) {
      case 0:
        var doorState = 'open';
        break;
      case 1:
        var doorState = 'closed';
        break;
      case 2:
        var doorState = 'stop';
        break;
      case 3:
        var doorState = 'stop';
        break;
      case 4:
        var doorState = 'open';
        break;
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

        this.garageservice
          .setCharacteristic(Characteristic.CurrentDoorState, currentState);
        callback(null); // success

      } else if (response && response.statusCode == 401) {

        this.log("Received 401 Unauthorized when setting state. Attempting token refresh...");
        this.refreshToken(function(refreshErr) {
          if (!refreshErr) {
            // Retry the set with the new token
            request.post({
              url: this.cloudURL + this.deviceID + '/setState',
              form: {
                access_token: this.access_token,
                args: doorState
              }
            }, function(err2, response2, body2) {
              if (!err2 && response2.statusCode == 200) {
                this.log("State change complete after token refresh.");
                var currentState = (state == Characteristic.TargetDoorState.CLOSED) ? Characteristic.CurrentDoorState.CLOSED : Characteristic.CurrentDoorState.OPEN;
                this.garageservice.setCharacteristic(Characteristic.CurrentDoorState, currentState);
                callback(null);
              } else {
                this.log("Error setting door state after token refresh: %s", err2);
                callback(err2 || new Error("Error setting door state."));
              }
            }.bind(this));
          } else {
            this.log("Token refresh failed. Update access_token manually in config.json.");
            callback(new Error("Token expired and could not be refreshed."));
          }
        }.bind(this));

      } else {

        this.log("Error '%s' setting door state. Response: %s", err, body);
        callback(err || new Error("Error setting door state."));
      }
    }.bind(this));
  }
/**
 * Sets Status of the Garadget for bypass trigger
 */
DoorAccessory.prototype.setStatebypass = function(state, callback) {
    this.log("state = ", state);
    var doorState = this.args.replace("{STATE}", (state ? "open" : "closed")); //flips on/off
    this.log("Set bypass state to %s", doorState);
    request.post({
      url: this.cloudURL + this.deviceID + '/setState',
      form: {
        access_token: this.access_token,
        args: doorState
      }
    }, function(err, response, body) {

      if (!err && response.statusCode == 200) {

        this.log("State bypass change complete.");
        callback(null); // success

      } else {

        this.log("Error '%s' setting bypass state. Response: %s", err, body);
        callback(err || new Error("Error setting bypass state."));
      }
    }.bind(this));
  }
/**
 * Checks token validity via ObstructionDetected characteristic.
 * ObstructionDetected = YES only on a genuine 401 Unauthorized response.
 * Other errors (network issues, server errors) are logged but do not
 * trigger the "token expired" warning.
 */
DoorAccessory.prototype.getOD = function(callback) {
    this.log("Get ObstructionDetected...");
    var url = this.cloudURL + this.deviceID + '/doorStatus?access_token=' + this.access_token;

    this.getWithRetry(url, 2, function(err, body) {
      if (!err) {
        this.log("Access Key good...");
        callback(null, 0); // success
      } else {
        // getWithRetry only surfaces a 401 as a token expiry error;
        // transient failures are retried internally and won't reach here
        // unless all retries are exhausted.
        if (err.message && err.message.indexOf("Token expired") !== -1) {
          this.log("Access token has expired. Add particle_username and particle_password to config.json for automatic refresh, or update access_token manually.");
          callback(null, 1); // ObstructionDetected = YES (token issue)
        } else {
          this.log("Transient error checking access token (not a token expiry): %s", err);
          callback(null, 0); // Don't flag as obstruction for non-auth errors
        }
      }
    }.bind(this));
  }
/**
 * Gets services
 */
DoorAccessory.prototype.getServices = function() {
    return [this.garageservice];
  }
/**
 * Parse the status out of the json file
 */
DoorAccessory.prototype.parseStatus = function(p_status) {
  var split1 = p_status.split("|")
  var split2 = split1[0].split("=")
  var a_result = split2[1]
  return a_result;
}
