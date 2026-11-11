/*
 * hive-schedule-card — view and edit the weekly heating + hot-water schedule held ON the
 * Hive SLR2 receiver, through Zigbee2MQTT, and pick who runs it.
 *
 * The SLR2 stores its own schedule: per channel (heat = endpoint 5, water = endpoint 6),
 * per day, exactly 6 transitions of {time, setpoint}. Heat "off" is setpoint 1 °C, water
 * is 99 (on) / 0 (off). In `auto` mode the receiver runs it by itself, so the house keeps
 * its schedule when HA or the cluster is down, and the SLT3 thermostat edits the same data.
 *
 * Reading: the card subscribes to the device's z2m state topic over HA's websocket
 * (`mqtt/subscribe`, which needs an HA ADMIN user) and asks z2m for the schedule with
 * `<topic>/get {"weekly_schedule_heat": ""}`. The receiver answers one message per day.
 * Writing: `<topic>/set {"weekly_schedule_heat": {dayofweek: [...], transitions: [...]}}`.
 *
 * "Runs on" switch: Thermostat = receiver in auto (its schedule). Home Assistant = receiver
 * in manual (heat / water on-off), so automations drive it directly.
 *
 * Config:
 *   type: custom:hive-schedule-card
 *   topic: z2m/heating                       # z2m base topic + device friendly name
 *   heat_entity: climate.heating_climate      # hive_local_thermostat climate
 *   water_entity: select.heating_water_mode   # hive_local_thermostat water select
 *   title: Heating schedule                   # optional
 */

const DAYS = [ // display order, with z2m day names
  { key: "monday", label: "Mon" }, { key: "tuesday", label: "Tue" },
  { key: "wednesday", label: "Wed" }, { key: "thursday", label: "Thu" },
  { key: "friday", label: "Fri" }, { key: "saturday", label: "Sat" },
  { key: "sunday", label: "Sun" },
];
const JS_DAY_TO_KEY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SLOTS = 6;
const HEAT_OFF = 1;
const WATER_ON = 99;
const HEAT_CHOICES = [HEAT_OFF];
for (let t = 5; t <= 28; t += 0.5) HEAT_CHOICES.push(t);

const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

class HiveScheduleCard extends HTMLElement {
  setConfig(config) {
    if (!config.topic) throw new Error("hive-schedule-card: `topic` is required (e.g. z2m/heating)");
    this._config = {
      title: "Heating schedule",
      heat_entity: "climate.heating_climate",
      water_entity: "select.heating_water_mode",
      ...config,
    };
    this._tab = "heat";
    this._sched = { heat: {}, water: {} };
    this._edit = null;
    this._status = "";
    this._ignoreUntil = 0;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  getCardSize() { return 7; }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._connect();
    // Re-render only for state we show (mode), never while an edit is open.
    const sig = [hass.states[this._config.heat_entity]?.state, hass.states[this._config.water_entity]?.state].join("|");
    if (sig !== this._sig) { this._sig = sig; if (!this._edit) this._render(); }
  }

  disconnectedCallback() { if (this._unsub) { this._unsub.then((u) => u && u()).catch(() => {}); this._unsub = null; this._connected = false; } }
  connectedCallback() { if (this._hass && !this._connected) this._connect(); }

  async _connect() {
    this._connected = true;
    try {
      this._unsub = this._hass.connection.subscribeMessage(
        (msg) => this._onMessage(msg.payload),
        { type: "mqtt/subscribe", topic: this._config.topic },
      );
      await this._unsub;
      await this._refresh();
    } catch (e) {
      this._status = `Can't read the receiver: ${e.message || e.code || e}. (MQTT subscribe needs an HA admin user.)`;
      this._render();
    }
  }

  async _publish(suffix, obj) {
    await this._hass.callService("mqtt", "publish", {
      topic: `${this._config.topic}/${suffix}`, payload: JSON.stringify(obj),
    });
  }

  async _refresh() {
    this._status = "Reading schedule from the receiver…";
    this._render();
    await this._publish("get", { weekly_schedule_heat: "" });
    await new Promise((r) => setTimeout(r, 1500));
    await this._publish("get", { weekly_schedule_water: "" });
    setTimeout(() => {
      if (this._status.startsWith("Reading")) {
        this._status = this._complete() ? "" : "Receiver didn't answer for every day. Try ↻.";
        if (!this._edit) this._render();
      }
    }, 6000);
  }

  _complete() { return ["heat", "water"].every((c) => DAYS.every((d) => this._sched[c][d.key])); }

  _onMessage(raw) {
    if (Date.now() < this._ignoreUntil) return; // z2m republishes its stale cache right after a write
    let p; try { p = JSON.parse(raw); } catch { return; }
    let changed = false;
    for (const ch of ["heat", "water"]) {
      const ws = p[`weekly_schedule_${ch}`];
      if (!ws || !Array.isArray(ws.days)) continue;
      const tr = (ws.transitions || []).map((t) => ({ t: t.time, v: t.heating_setpoint }));
      for (const day of ws.days) {
        if (JSON.stringify(this._sched[ch][day]) !== JSON.stringify(tr)) { this._sched[ch][day] = tr; changed = true; }
      }
    }
    if (changed) {
      if (this._status.startsWith("Reading") && this._complete()) this._status = "";
      if (!this._edit) this._render();
    }
  }

  // Value in force at minute m of a day: the last transition at or before m, else the
  // previous day's final value (the schedule wraps over midnight).
  _valueAt(ch, dayIdx, m) {
    const tr = this._sched[ch][DAYS[dayIdx].key];
    if (!tr || !tr.length) return null;
    let v = null;
    for (const t of tr) if (t.t <= m) v = t.v;
    if (v !== null) return v;
    const prev = this._sched[ch][DAYS[(dayIdx + 6) % 7].key];
    return prev && prev.length ? prev[prev.length - 1].v : tr[tr.length - 1].v;
  }

  _isOn(ch, v) { return ch === "heat" ? v > HEAT_OFF + 0.01 : v > 0; }

  _segments(ch, dayIdx) {
    const tr = this._sched[ch][DAYS[dayIdx].key];
    if (!tr) return [];
    const pts = [{ t: 0, v: this._valueAt(ch, dayIdx, 0) }, ...tr.filter((x) => x.t > 0)];
    const segs = [];
    pts.forEach((p, i) => {
      const end = i + 1 < pts.length ? pts[i + 1].t : 1440;
      if (end <= p.t) return;
      const last = segs[segs.length - 1];
      if (last && last.v === p.v) last.end = end; else segs.push({ start: p.t, end, v: p.v });
    });
    return segs;
  }

  _mode(ch) {
    const s = this._hass?.states[ch === "heat" ? this._config.heat_entity : this._config.water_entity]?.state;
    return { raw: s, thermostat: s === "auto" };
  }

  async _setRunsOn(ch, thermostat) {
    const now = new Date();
    const dayIdx = DAYS.findIndex((d) => d.key === JS_DAY_TO_KEY[now.getDay()]);
    const scheduledOn = this._isOn(ch, this._valueAt(ch, dayIdx, now.getHours() * 60 + now.getMinutes()) ?? 0);
    if (ch === "heat") {
      await this._hass.callService("climate", "set_hvac_mode", {
        entity_id: this._config.heat_entity, hvac_mode: thermostat ? "auto" : "heat",
      });
    } else {
      // Hand over without a jump: in HA mode, start from whatever the schedule says right now.
      await this._hass.callService("select", "select_option", {
        entity_id: this._config.water_entity, option: thermostat ? "auto" : (scheduledOn ? "heat" : "off"),
      });
    }
  }

  _openEditor(dayIdx) {
    const ch = this._tab;
    const tr = this._sched[ch][DAYS[dayIdx].key];
    if (!tr) return;
    const slots = tr.map((x) => ({ ...x }));
    while (slots.length < SLOTS) slots.push({ t: slots.length ? Math.min(1439, slots[slots.length - 1].t + 1) : 0, v: ch === "heat" ? HEAT_OFF : 0 });
    this._edit = { ch, dayIdx, slots: slots.slice(0, SLOTS), days: new Set([DAYS[dayIdx].key]), error: "" };
    this._render();
  }

  async _save() {
    const e = this._edit;
    for (let i = 1; i < e.slots.length; i++) {
      if (e.slots[i].t <= e.slots[i - 1].t) { e.error = `Slot ${i + 1} must be later than slot ${i}.`; this._render(); return; }
    }
    if (!e.days.size) { e.error = "Pick at least one day."; this._render(); return; }
    const payload = {
      [`weekly_schedule_${e.ch}`]: {
        dayofweek: DAYS.filter((d) => e.days.has(d.key)).map((d) => d.key),
        transitions: e.slots.map((s) => ({ heatSetpoint: s.v, transitionTime: fmt(s.t) })),
      },
    };
    this._status = "Saving to the receiver…";
    this._ignoreUntil = Date.now() + 2500;
    this._edit = null;
    this._render();
    try {
      await this._publish("set", payload);
      for (const d of payload[`weekly_schedule_${e.ch}`].dayofweek) delete this._sched[e.ch][d];
      setTimeout(async () => {
        await this._publish("get", { [`weekly_schedule_${e.ch}`]: "" });
        setTimeout(() => {
          const missing = DAYS.filter((d) => !this._sched[e.ch][d.key]).length;
          this._status = missing ? "Saved, but the receiver didn't confirm every day. Try ↻." : "Saved ✓";
          this._render();
          setTimeout(() => { if (this._status === "Saved ✓") { this._status = ""; this._render(); } }, 3000);
        }, 5000);
      }, 2600);
    } catch (err) {
      this._status = `Save failed: ${err.message || err}`;
      this._render();
    }
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const ch = this._tab;
    const mode = this._mode(ch);
    const now = new Date();
    const todayKey = JS_DAY_TO_KEY[now.getDay()];
    const nowPct = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;

    const rows = DAYS.map((d, i) => {
      const segs = this._segments(ch, i);
      const bars = segs.map((s) => {
        const on = this._isOn(ch, s.v);
        const left = (s.start / 1440) * 100, width = ((s.end - s.start) / 1440) * 100;
        const label = on && width > 7 ? (ch === "heat" ? `${s.v}°` : "On") : "";
        const title = `${fmt(s.start)}–${s.end === 1440 ? "24:00" : fmt(s.end)} ${on ? (ch === "heat" ? s.v + " °C" : "on") : "off"}`;
        return `<div class="seg ${on ? "on " + ch : "off"}" style="left:${left}%;width:${width}%" title="${title}">${label}</div>`;
      }).join("");
      const now_ = d.key === todayKey ? `<div class="now" style="left:${nowPct}%"></div>` : "";
      const loading = segs.length ? "" : `<div class="loading">…</div>`;
      return `<div class="row" data-day="${i}"><div class="day ${d.key === todayKey ? "today" : ""}">${d.label}</div><div class="track">${bars}${loading}${now_}</div></div>`;
    }).join("");

    const ticks = [0, 6, 12, 18, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, "0")}</span>`).join("");

    let editor = "";
    if (this._edit) {
      const e = this._edit;
      const slotRows = e.slots.map((s, i) => {
        const valueCtl = e.ch === "heat"
          ? `<select data-slot="${i}" data-f="v">${HEAT_CHOICES.map((t) => `<option value="${t}" ${Math.abs(t - s.v) < 0.01 ? "selected" : ""}>${t === HEAT_OFF ? "Off" : t + " °C"}</option>`).join("")}</select>`
          : `<select data-slot="${i}" data-f="v"><option value="${WATER_ON}" ${s.v > 0 ? "selected" : ""}>On</option><option value="0" ${s.v > 0 ? "" : "selected"}>Off</option></select>`;
        // Hour + minute selects, not <input type=time>: that one renders in the browser's
        // locale and showed 14:00 as "02:00" with AM/PM clipped on an en-US phone.
        const h = Math.floor(s.t / 60), m = s.t % 60;
        const mins = [...new Set([...Array(12).keys()].map((k) => k * 5).concat(m))].sort((a, b) => a - b);
        const hourSel = `<select data-slot="${i}" data-f="h">${[...Array(24).keys()].map((x) => `<option value="${x}" ${x === h ? "selected" : ""}>${String(x).padStart(2, "0")}</option>`).join("")}</select>`;
        const minSel = `<select data-slot="${i}" data-f="m">${mins.map((x) => `<option value="${x}" ${x === m ? "selected" : ""}>${String(x).padStart(2, "0")}</option>`).join("")}</select>`;
        return `<div class="slot"><span class="n">${i + 1}</span><span class="time">${hourSel}<b>:</b>${minSel}</span>${valueCtl}</div>`;
      }).join("");
      const chips = DAYS.map((d) => `<button class="chip ${e.days.has(d.key) ? "sel" : ""}" data-chip="${d.key}">${d.label}</button>`).join("");
      editor = `
        <div class="editor">
          <div class="ehead">Edit ${e.ch === "heat" ? "heating" : "hot water"} · ${DAYS[e.dayIdx].label}</div>
          <div class="slots">${slotRows}</div>
          <div class="apply"><span>Apply to</span>${chips}
            <button class="chip q" data-quick="wk">Mon–Fri</button><button class="chip q" data-quick="we">Sat–Sun</button><button class="chip q" data-quick="all">All</button></div>
          ${e.error ? `<div class="err">${e.error}</div>` : ""}
          <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Save to receiver</button></div>
        </div>`;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { --on-heat: var(--state-climate-heat-color, #ff8100); --on-water: var(--state-water_heater-eco-color, #2196f3); }
        ha-card { padding: 16px; }
        .head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .title { font-size: 1.15em; font-weight: 500; }
        .icon { background:none; border:none; color: var(--secondary-text-color); font-size: 1.2em; cursor:pointer; padding:4px 8px; }
        .tabs { display:flex; gap:4px; margin:12px 0 8px; background: var(--secondary-background-color); border-radius: 10px; padding:3px; }
        .tab { flex:1; border:none; background:none; padding:8px; border-radius:8px; cursor:pointer; color: var(--primary-text-color); font: inherit; }
        .tab.sel { background: var(--card-background-color); box-shadow: 0 1px 2px rgba(0,0,0,.15); font-weight:500; }
        .runs { display:flex; align-items:center; gap:8px; margin: 4px 0 14px; font-size:.9em; color: var(--secondary-text-color); flex-wrap: wrap; }
        .seg2 { display:flex; border:1px solid var(--divider-color); border-radius: 8px; overflow:hidden; }
        .seg2 button { border:none; background:none; padding:6px 10px; cursor:pointer; color: var(--primary-text-color); font: inherit; font-size: .95em; }
        .seg2 button.sel { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .rawmode { opacity:.7; }
        .row { display:flex; align-items:center; gap:8px; margin: 5px 0; cursor:pointer; }
        .day { width: 34px; font-size:.9em; color: var(--secondary-text-color); }
        .day.today { color: var(--primary-color); font-weight:600; }
        .track { position:relative; flex:1; height: 26px; border-radius: 6px; background: var(--secondary-background-color); overflow:hidden; }
        .row:hover .track { outline: 1px solid var(--primary-color); }
        .seg { position:absolute; top:0; bottom:0; display:flex; align-items:center; justify-content:center; font-size:.75em; color:#fff; white-space:nowrap; }
        .seg.off { background: transparent; }
        .seg.on.heat { background: var(--on-heat); }
        .seg.on.water { background: var(--on-water); }
        .now { position:absolute; top:-2px; bottom:-2px; width:2px; background: var(--primary-text-color); opacity:.8; }
        .loading { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color: var(--secondary-text-color); }
        .ticks { position:relative; height: 14px; margin-left: 42px; font-size:.7em; color: var(--secondary-text-color); }
        .ticks span { position:absolute; transform: translateX(-50%); }
        .ticks span:first-child { transform:none; } .ticks span:last-child { transform: translateX(-100%); }
        .status { margin-top: 10px; font-size: .85em; color: var(--secondary-text-color); min-height: 1em; }
        .hint { font-size:.8em; color: var(--secondary-text-color); margin-top: 6px; }
        .editor { margin-top: 14px; border-top: 1px solid var(--divider-color); padding-top: 12px; }
        .ehead { font-weight:500; margin-bottom: 8px; }
        .slots { display:grid; grid-template-columns: 1fr; gap: 8px; }
        .slot { display:flex; align-items:center; gap:6px; }
        .slot .n { width: 16px; color: var(--secondary-text-color); font-size:.85em; }
        .slot input, .slot select { font: inherit; padding: 6px; border-radius: 6px; border:1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); min-width: 0; }
        .slot .time { display:flex; align-items:center; gap:2px; }
        .slot .time b { color: var(--secondary-text-color); font-weight: normal; }
        .slot > select { flex: 1; }
        .apply { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top: 12px; font-size:.9em; }
        .apply > span { color: var(--secondary-text-color); margin-right: 4px; }
        .chip { border:1px solid var(--divider-color); background:none; border-radius: 14px; padding: 4px 10px; cursor:pointer; color: var(--primary-text-color); font: inherit; font-size: .9em; }
        .chip.sel { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
        .chip.q { border-style: dashed; }
        .err { color: var(--error-color, #db4437); margin-top: 8px; font-size: .9em; }
        .actions { display:flex; justify-content:flex-end; gap: 8px; margin-top: 12px; }
        .btn { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--divider-color); background:none; color: var(--primary-text-color); cursor:pointer; }
        .btn.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
      </style>
      <ha-card>
        <div class="head"><div class="title">${this._config.title}</div><button class="icon" data-act="refresh" title="Re-read from receiver">↻</button></div>
        <div class="tabs">
          <button class="tab ${ch === "heat" ? "sel" : ""}" data-tab="heat">Heating</button>
          <button class="tab ${ch === "water" ? "sel" : ""}" data-tab="water">Hot water</button>
        </div>
        <div class="runs">Runs on
          <div class="seg2">
            <button class="${mode.thermostat ? "sel" : ""}" data-runs="thermostat">Thermostat schedule</button>
            <button class="${mode.thermostat ? "" : "sel"}" data-runs="ha">Home Assistant</button>
          </div>
          ${mode.thermostat ? "" : `<span class="rawmode">(receiver: ${mode.raw ?? "unknown"})</span>`}
        </div>
        ${rows}
        <div class="ticks">${ticks}</div>
        ${editor}
        <div class="status">${this._status}</div>
        ${this._edit ? "" : `<div class="hint">Tap a day to edit. ${mode.thermostat ? "" : "Not running: the receiver is in manual, so HA is in charge."}</div>`}
      </ha-card>`;

    const $ = (sel) => this.shadowRoot.querySelectorAll(sel);
    $("[data-tab]").forEach((b) => b.addEventListener("click", () => { this._tab = b.dataset.tab; this._edit = null; this._render(); }));
    $("[data-runs]").forEach((b) => b.addEventListener("click", () => this._setRunsOn(ch, b.dataset.runs === "thermostat")));
    $(".row").forEach((r) => r.addEventListener("click", () => this._openEditor(Number(r.dataset.day))));
    $("[data-act=refresh]").forEach((b) => b.addEventListener("click", () => { this._sched = { heat: {}, water: {} }; this._edit = null; this._refresh(); }));
    if (this._edit) {
      const e = this._edit;
      $("[data-slot]").forEach((el) => el.addEventListener("change", () => {
        const s = e.slots[Number(el.dataset.slot)];
        const n = Number(el.value);
        if (el.dataset.f === "h") s.t = n * 60 + (s.t % 60);
        else if (el.dataset.f === "m") s.t = Math.floor(s.t / 60) * 60 + n;
        else s.v = n;
      }));
      $("[data-chip]").forEach((c) => c.addEventListener("click", () => {
        e.days.has(c.dataset.chip) ? e.days.delete(c.dataset.chip) : e.days.add(c.dataset.chip); this._render();
      }));
      $("[data-quick]").forEach((c) => c.addEventListener("click", () => {
        const q = c.dataset.quick;
        e.days = new Set(DAYS.filter((d, i) => q === "all" || (q === "wk" ? i < 5 : i >= 5)).map((d) => d.key));
        this._render();
      }));
      $("[data-act=cancel]").forEach((b) => b.addEventListener("click", () => { this._edit = null; this._render(); }));
      $("[data-act=save]").forEach((b) => b.addEventListener("click", () => this._save()));
    }
  }

  static getStubConfig() { return { topic: "z2m/heating" }; }
}

customElements.define("hive-schedule-card", HiveScheduleCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "hive-schedule-card",
  name: "Hive schedule",
  description: "View and edit the heating and hot-water schedule stored on a Hive SLR2 receiver via Zigbee2MQTT.",
});
