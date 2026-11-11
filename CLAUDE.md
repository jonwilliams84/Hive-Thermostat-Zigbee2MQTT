# Hive Thermostat via Zigbee2MQTT

Home Assistant YAML configuration that recreates the Hive remote's behaviour for
a Hive thermostat exposed through Zigbee2MQTT. There is no application code,
build, or test step — these are config snippets you copy into a Home Assistant
setup. (Upstream is greeeny101/Hive-Thermostat-Zigbee2MQTT.)

## Why it exists
HA's climate/MQTT integration publishes commands in a format Zigbee2MQTT doesn't
understand for this device, which makes the thermostat fall back to a 1 °C
setpoint. The fix is a **proxy thermostat**: an MQTT HVAC `climate` entity
(`climate.heating_proxy`) whose commands are re-published to proxy topics, then
caught by automations that emit correctly-formatted JSON to the real device.

## Layout
- `SLR1/` — heating only.
- `SLR2/` — heating **and** hot water (adds swing-mode for water, battery sensor).
- Each variant has three folders, mapping to HA config sections:
  - `config_mqtt/hive.yaml` — MQTT `sensor:` + `climate:` (the proxy entity).
  - `config_input_number/hive.yaml` — helpers: boost temp, frost prevention, boost duration.
  - `config_automation/hive.yaml` — automations that translate proxy commands → device topics.
- `card/hive-schedule-card.js` — Lovelace card: week grid + editor for the schedule stored ON the SLR2, plus the per-channel Thermostat/Home Assistant switch. Plain JS, no build; deployed to HA `/config/www/`.
- `SLR2/config_automation/clock_sync.yaml` — hourly genTime write; the SLR2 never syncs its own clock.
- `Capture.PNG` — Lovelace screenshot. `README.md` has the simple-thermostat card YAML.

## Data flow / key topics
- Device state in: `zigbee2mqtt/heating` (and water topic in SLR2).
- Proxy command topics: `zigbee2mqtt/heating_proxy/occupied_heating_setpoint`,
  `zigbee2mqtt/heating_proxy/system_mode`.
- Device command topic: `zigbee2mqtt/heating/set` (published by automations).
- HA modes are mapped onto device fields: `auto`=Schedule, `heat`=Manual,
  `cool`=Boost (device `emergency_heating`), `off`=Off. SLR2 uses `swing` for water.

## Conventions / gotchas
- A `1` setpoint payload is the device's error signal — automations explicitly
  ignore `payload == 1` and substitute `input_number.heating_frost_prevention`.
- `temperature_setpoint_hold_duration == 65535` distinguishes manual hold from a
  running schedule; `0` resumes schedule. Don't change these magic numbers casually.
- Device ignores attribute *ordering*, so commands are split across two
  `mqtt.publish` calls with a `delay: 0.5` between them — keep that pattern.
- `input_number` helpers have `initial:` values that reset on HA restart; remove
  `initial:` to persist the user's last value.
- These files are HA config fragments, not standalone — they go under the matching
  `mqtt:`, `input_number:`, and `automation:` keys (e.g. via `!include`/packages).
- The SLR2 schedule is 6 transitions per day per channel, exactly; heat off = 1 °C,
  water on/off = 99/0. Read replies arrive one message per day.
- `<input type=time>` renders in the browser locale (12 h on en-US, AM/PM clipped);
  the card uses hour/minute selects for that reason.
