# homebridge-garadget-cloudmqtt

Homebridge plugin for [Garadget](https://www.garadget.com/) garage door controllers. Supports both **local MQTT** (recommended) and **Particle Cloud** (REST) modes.

## Why this plugin?

The original Homebridge Garadget plugins either rely entirely on Particle Cloud or are unmaintained. This plugin:

- Works **locally over MQTT** — no internet required to open your garage
- Falls back to **Particle Cloud** if you prefer or need remote access
- Pushes **real-time state updates** to HomeKit the moment the door moves (no polling delay)
- Automatically populates HomeKit accessory info (firmware version, serial number) from the device
- Exposes an optional **ambient light sensor** in HomeKit
- Properly distinguishes token expiry errors from transient network issues in cloud mode

---

## Requirements

- [Homebridge](https://homebridge.io/) v0.4.0 or later
- Garadget device with firmware v1.17 or later (for MQTT support)
- A local MQTT broker (e.g. [Mosquitto](https://mosquitto.org/)) for MQTT mode

---

## Installation

Install via the Homebridge UI by searching for `homebridge-garadget-cloudmqtt`, or:

```bash
npm install -g homebridge-garadget-cloudmqtt
```

---

## Configuration

The easiest way to configure this plugin is through the Homebridge UI — it will show a form and only ask for the fields relevant to your chosen mode.

### MQTT mode (recommended)

```json
{
  "accessory": "GaradgetCloudMQTT",
  "name": "Garage Door",
  "mode": "mqtt",
  "mqtt_server": "mqtt://192.168.1.100",
  "mqtt_user": "your_mqtt_user",
  "mqtt_pass": "your_mqtt_pass",
  "device_name": "MyGarage",
  "update_interval": 60,
  "light_sensor": false,
  "bypass": "0",
  "args": "{STATE}"
}
```

### Cloud mode (Particle)

```json
{
  "accessory": "GaradgetCloudMQTT",
  "name": "Garage Door",
  "mode": "cloud",
  "cloudURL": "https://api.particle.io/v1/devices/",
  "deviceID": "your_device_id",
  "access_token": "your_access_token",
  "particle_username": "your@email.com",
  "particle_password": "yourpassword",
  "bypass": "0",
  "args": "{STATE}"
}
```

### Config options

| Option | Required | Description |
|---|---|---|
| `name` | Yes | Accessory name shown in HomeKit |
| `mode` | Yes | `mqtt` or `cloud` |
| `mqtt_server` | MQTT | MQTT broker URL e.g. `mqtt://192.168.1.100` |
| `device_name` | MQTT | Device name configured on the Garadget hardware |
| `mqtt_user` | No | MQTT username (omit if broker allows anonymous) |
| `mqtt_pass` | No | MQTT password |
| `update_interval` | No | Seconds between status polls, default `60` |
| `light_sensor` | No | `true` to expose light sensor in HomeKit |
| `blip_filter` | No | Seconds to hold a closed-to-opening report before telling HomeKit; discards it if the door reports closed again within the window (filters phantom sensor glitches). Default `3`, `0` disables |
| `cloudURL` | Cloud | Particle Cloud API URL |
| `deviceID` | Cloud | Your Garadget device ID |
| `access_token` | Cloud | Your Particle access token |
| `particle_username` | No | Particle email for automatic token refresh |
| `particle_password` | No | Particle password for automatic token refresh |
| `bypass` | No | `0` = garage door opener, `1` = switch (suppresses HomeKit trigger warning) |

---

## Setting up local MQTT on the Garadget device

1. Hold the **M button** on the device ~3 seconds until the LED blinks dark blue
2. Connect to the **PHOTON-XXXX** WiFi network it broadcasts
3. Open `https://192.168.0.1/` in your browser
4. Set the MQTT broker IP, port (1883), and device name
5. Select **Cloud + MQTT** mode to keep the Garadget app working alongside Homebridge
6. Submit and let the device reconnect to your WiFi

Verify it's working:
```bash
mosquitto_sub -h 192.168.1.100 -t "garadget/#" -v
```
You should see status messages when the door opens or closes.

---

## Features

- **Real-time updates** — door state changes are pushed to HomeKit instantly via MQTT
- **Automatic device info** — firmware version and serial number are read from the device and shown in HomeKit
- **Light sensor** — exposes the Garadget's built-in ambient light sensor as a HomeKit accessory
- **Retry logic** — transient network errors are retried automatically in cloud mode
- **Token refresh** — expired Particle tokens are refreshed automatically if credentials are provided
- **Bypass mode** — suppresses the HomeKit trigger warning for use in automations

---

## Credits

Originally forked from [homebridge-garadget](https://github.com/xNinjasx/homebridge-garadget) by xNinjasx.
