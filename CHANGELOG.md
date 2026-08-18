# Changelog

All notable changes to homebridge-garadget-cloudmqtt.

## 0.1.12

- Fixed the door stopping or reversing mid-travel when a command arrives while the door is still moving (for example opening with the wall button, then closing from HomeKit before the door finishes opening). Single-button openers treat any relay pulse during motion as "stop", which stranded the door half-way. The plugin now queues a reversal command until the door finishes its current travel, waits 2 seconds for it to settle, then sends it.
- Recommended device setting: make sure Door Motion Time in the Garadget app is at least as long as your door's real travel time, since the device declares "open" on that timer.

## 0.1.11

- Fixed the door becoming uncontrollable from HomeKit after it gets stuck mid-travel. When a close attempt fails and the device reports "stopped", HomeKit's stored target was still "closed", so further close taps were treated as redundant by iOS and never delivered; the Garadget app kept working because it has no stored target. The plugin now resets the target to "open" whenever the door reports "stopped", so the next tap is a real state change and goes through.

## 0.1.10

- Added this changelog to the published package so release notes appear in the Homebridge UI.

## 0.1.9

- Added a sensor blip filter: when a closed door suddenly reports opening, the plugin now waits a few seconds (configurable, default 3) before telling HomeKit. If the door reports closed again within the window, the event is discarded as a sensor glitch. This eliminates phantom "door closed" notifications caused by single-scan sensor dropouts (for example an insect crossing the lens).
- New `blip_filter` config option in the plugin settings. Set to `0` to disable.

## 0.1.8

- Fixed the door sometimes stopping after moving only a few inches when controlled from HomeKit. The plugin now tracks TargetDoorState properly, keeps it in sync with the door's actual movement, and ignores redundant open/close commands when the door is already at or moving toward the requested state, so the opener relay is never pulsed twice for one intent.
- TargetDoorState reads now always return valid values (open or closed), never transitional states.

## 0.1.7

- Config UI: all settings fields are now always visible. The conditional show/hide logic did not render reliably in some Homebridge UI versions, leaving the form empty.

## 0.1.6

- Fixed the plugin settings screen not appearing in the Homebridge UI (`config.schema.json` was missing from the published package).
- Added Node.js 24 to the supported engines.
- Declared Homebridge v2.0 compatibility.

## 0.1.1

- Fixed serial number and firmware version showing as "Unknown"/"0.0" in HomeKit. Accessory information is now served dynamically from the device's MQTT config payload.

## 0.1.0

Initial release, forked from homebridge-garadget by xNinjasx.

- Local MQTT mode: control the door over your LAN with no internet or Particle Cloud dependency, with real-time state updates pushed to HomeKit the moment the door moves.
- Particle Cloud (REST) mode retained as an option.
- Optional ambient light sensor exposed to HomeKit (MQTT mode).
- HomeKit accessory info (firmware version, serial number) auto-populated from the device.
- Homebridge UI configuration screen.
- Cloud mode: transient network errors are no longer misreported as token expiry; requests are retried, and expired tokens are refreshed automatically when Particle credentials are configured.
