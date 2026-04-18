/**
 * =====================================================
 * SMART WATER METERING SYSTEM — DASHBOARD
 * =====================================================
 */

"use strict";

// =====================================================
// ⚠️  FIREBASE CONFIG HERE  ⚠️
// All this from: Firebase Console => Project Settings => Your apps => Web app => firebaseConfig
// =====================================================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAGpFV4XpdNc9J50bj7RMFi2k8W_4AZJIo",
  authDomain: "iot-smart-h20-metering-system.firebaseapp.com",
  databaseURL:
    "https://iot-smart-h20-metering-system-default-rtdb.firebaseio.com/",
  projectId: "iot-smart-h20-metering-system",
  storageBucket: "iot-smart-h20-metering-system.firebasestorage.app",
  messagingSenderId: "148620704926",
  appId: "1:148620704926:web:752030aa30e144ba4a0f8f",
};

// =====================================================
// CREDENTIALS  (as per preference)
// =====================================================
const DASHBOARD_USER = "admin";
const DASHBOARD_PASS = "@tacheneswa123";

// =====================================================
// MAIN DASHBOARD CLASS
// =====================================================
class WaterDashboard {
  constructor() {
    // Firebase refs
    this.db = null;
    this.sensorRef = null;
    this.cmdRef = null;
    this.alertsRef = null;
    this.dailyLogRef = null;
    this.unsubSensor = null;

    // Chart instances
    this.flowChart = null;
    this.consumptionChart = null;

    // App state
    this.currentData = null;
    this.alerts = [];
    this.isLoggedIn = false;
    this.esp32Online = false;

    // Stale-data watchdog
    this.lastDataTimestamp = 0;
    this.staleCheckInterval = null;
    this.STALE_THRESHOLD_MS = 20000; // if no update in 20s, mark offline

    // Flow chart rolling buffer
    this.chartBuffer = {
      labels: [],
      srcFlow: [],
      dstFlow: [],
      srcTotal: [],
      dstTotal: [],
      maxPoints: 60,
    };

    // Leak countdown
    this.leakCountdown = null;

    this.init();
  }

  // ══════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════
  init() {
    this.setupEventListeners();
    this.createToastContainer();

    if (sessionStorage.getItem("wm_logged_in") === "true") {
      this.isLoggedIn = true;
      this.showDashboard();
    } else {
      this.showWelcomeScreen();
    }
  }

  // ══════════════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════════════
  showWelcomeScreen() {
    this.setDisplay("welcomeScreen", "block");
    this.setDisplay("dashboard", "none");
    this.setDisplay("loginModal", "none");
  }

  showLoginModal() {
    this.setDisplay("loginModal", "flex");
    this.setDisplay("welcomeScreen", "none");
  }

  showDashboard() {
    this.setDisplay("dashboard", "block");
    this.setDisplay("welcomeScreen", "none");
    this.setDisplay("loginModal", "none");

    if (!this.db) {
      this.initFirebase();
      this.initCharts();
    }
  }

  handleLogin(e) {
    e.preventDefault();
    const u = document.getElementById("username").value.trim();
    const p = document.getElementById("password").value;
    const errDiv = document.getElementById("loginError");

    if (u === DASHBOARD_USER && p === DASHBOARD_PASS) {
      this.isLoggedIn = true;
      sessionStorage.setItem("wm_logged_in", "true");
      errDiv.style.display = "none";
      this.showDashboard();
    } else {
      errDiv.textContent = "❌ Invalid credentials. Please try again.";
      errDiv.style.display = "block";
    }
  }

  handleLogout() {
    this.isLoggedIn = false;
    sessionStorage.removeItem("wm_logged_in");
    if (this.unsubSensor) {
      this.unsubSensor();
      this.unsubSensor = null;
    }
    clearInterval(this.staleCheckInterval);
    this.showWelcomeScreen();
  }

  // ══════════════════════════════════════════════════
  // FIREBASE INIT & LISTENERS
  // ══════════════════════════════════════════════════
  initFirebase() {
    // Firebase v9 compat (loaded via CDN in index.html)
    firebase.initializeApp(FIREBASE_CONFIG);
    this.db = firebase.database();

    this.sensorRef = this.db.ref("sensorData");
    this.cmdRef = this.db.ref("pumpCommand");
    this.alertsRef = this.db.ref("alerts");
    this.dailyLogRef = this.db.ref("dailyLog");

    // ── Connection state ─────────────────────────
    this.db.ref(".info/connected").on("value", (snap) => {
      const connected = snap.val() === true;
      this.updateConnectionUI(
        connected,
        connected ? "Firebase Connected" : "Firebase Offline",
      );
      if (!connected) {
        this.updateESP32Status(false);
      }
    });

    // ── Live sensor data ─────────────────────────
    this.unsubSensor = this.sensorRef.on("value", (snap) => {
      const data = snap.val();
      if (!data) return;

      this.lastDataTimestamp = Date.now();
      this.handleSensorData(data);
      this.updateESP32Status(true);
      this.logDailyData(data); // accumulate for consumption chart
    });

    // ── Alerts listener ──────────────────────────
    this.alertsRef.on("value", (snap) => {
      const raw = snap.val();
      if (!raw) {
        this.alerts = [];
        this.renderAlerts();
        return;
      }
      this.alerts = Object.entries(raw).map(([id, a]) => ({ id, ...a }));
      this.alerts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      this.renderAlerts();
    });

    // ── Load consumption chart from daily log ────
    this.loadConsumptionData();

    // ── Stale-data watchdog ──────────────────────
    this.staleCheckInterval = setInterval(() => {
      if (
        this.lastDataTimestamp > 0 &&
        Date.now() - this.lastDataTimestamp > this.STALE_THRESHOLD_MS
      ) {
        this.updateESP32Status(false);
        this.clearSensorReadings();
      }
    }, 3000);

    console.log("Firebase connected and listening.");
  }

  // ══════════════════════════════════════════════════
  // SENSOR DATA HANDLER
  // ══════════════════════════════════════════════════
  handleSensorData(data) {
    this.currentData = data;

    // ── Flow rate cards ──────────────────────────
    this.setText("sourceFlowValue", (data.sourceFlow || 0).toFixed(2));
    this.setText("destFlowValue", (data.destFlow || 0).toFixed(2));
    this.setText("sourceTotalValue", (data.sourceTotalLiters || 0).toFixed(1));
    this.setText("destTotalValue", (data.destTotalLiters || 0).toFixed(1));
    this.setText(
      "totalConsumptionValue",
      ((data.sourceTotalLiters || 0) + (data.destTotalLiters || 0)).toFixed(1),
    );
    this.setText(
      "flowDifferentialValue",
      (data.flowDifferential || 0).toFixed(2),
    );
    this.setText(
      "literDifferenceValue",
      (data.literDifference || 0).toFixed(1),
    );
    this.setText("lossPercentageValue", (data.lossPercentage || 0).toFixed(1));

    // ── Uptime ───────────────────────────────────
    if (data.uptime !== undefined) {
      const ft = this.formatUptime(data.uptime);
      this.setText("systemUptimeDisplay", ft);
      this.setText("systemUptime", ft);
    }

    // ── System status ────────────────────────────
    this.setText("systemStatusText", data.systemStatus || "NORMAL");
    this.setText("dataSource", "Firebase RTDB");

    // ── Timestamp ────────────────────────────────
    const ts = new Date().toLocaleTimeString();
    this.setText("lastUpdate", ts);
    this.setText("lastUpdateText", ts);

    // ── Pump UI ──────────────────────────────────
    if (data.pumpESP32Connected) {
      this.updatePumpUI(data.pumpStatus === "ON");
    } else {
      const badge = document.getElementById("pumpStatusBadge");
      const label = document.getElementById("pumpStatusText");
      if (badge) {
        badge.textContent = "Pump Ctrl Offline";
        badge.className = "kpi-badge offline";
      }
      if (label) label.textContent = "Pump Ctrl Offline";
    }

    // ── Leak detection ───────────────────────────
    this.updateLeakState(data);

    // ── KPI card colour coding ───────────────────
    this.updateKPICardColors(data);

    // ── Auto-create leak alert if needed ────────
    if (data.leakDetected) this.maybeCreateLeakAlert(data);

    // ── Feed flow chart ──────────────────────────
    this.pushChartPoint(data, new Date());
  }

  // ══════════════════════════════════════════════════
  // PUMP CONTROL  (writes to Firebase - ESP32 reads it)
  // ══════════════════════════════════════════════════
  async controlPump(action) {
    if (action === "on" && this.currentData?.leakDetected) {
      if (
        !confirm(
          "⚠️ A leak was detected. Start pump anyway?\nThis may waste water.",
        )
      )
        return;
    }

    const onBtn = document.getElementById("pumpOnBtn");
    const offBtn = document.getElementById("pumpOffBtn");
    if (onBtn) onBtn.disabled = true;
    if (offBtn) offBtn.disabled = true;

    this.toast(`⏳ Sending pump ${action.toUpperCase()} command...`, "info");

    try {
      await this.cmdRef.set({
        action: action,
        requestedAt: Date.now(),
      });
      this.toast(
        `✅ Pump ${action.toUpperCase()} command sent - awaiting hardware`,
        "success",
      );
    } catch (err) {
      this.toast(`❌ Firebase write failed: ${err.message}`, "error");
    } finally {
      if (onBtn) onBtn.disabled = false;
      if (offBtn) offBtn.disabled = false;
    }
  }

  async resetSystem() {
    if (
      !confirm(
        "Reset the system?\n\n" +
          "• All session consumption counters reset to 0\n" +
          "• ESP32 EEPROM totals cleared\n" +
          "• Leak detection state cleared\n\n" +
          "This cannot be undone.",
      )
    )
      return;

    try {
      await this.cmdRef.set({ action: "reset", requestedAt: Date.now() });

      // Also clear local daily log and alerts in Firebase
      await this.dailyLogRef.remove();
      await this.alertsRef.remove();

      this.alerts = [];
      this.clearChartBuffer();
      this.resetDisplayValues();
      this.renderAlerts();
      this.toast("🔄 System reset - all counters cleared", "success");

      setTimeout(() => this.loadConsumptionData(), 1500);
    } catch (err) {
      this.toast(`❌ Reset failed: ${err.message}`, "error");
    }
  }

  // ══════════════════════════════════════════════════
  // ALERT MANAGEMENT  (Firebase-backed)
  // ══════════════════════════════════════════════════
  maybeCreateLeakAlert(data) {
    const existing = this.alerts.find((a) => !a.resolved && a.type === "leak");
    if (existing) return;

    const alertObj = {
      id: `leak_${Date.now()}`,
      type: "leak",
      title: "Leak Detected - Pump Auto-Stopped",
      message:
        `Source: ${(data.sourceFlow || 0).toFixed(2)} L/min | ` +
        `Dest collapsed to: ${(data.destFlow || 0).toFixed(2)} L/min | ` +
        `Differential: ${(data.flowDifferential || 0).toFixed(2)} L/min | ` +
        `Loss so far: ${(data.literDifference || 0).toFixed(2)} L`,
      severity: "high",
      timestamp: new Date().toISOString(),
      resolved: false,
      srcAtEvent: data.sourceFlow || 0,
      dstAtEvent: data.destFlow || 0,
      diffAtEvent: data.flowDifferential || 0,
      lossAtEvent: data.literDifference || 0,
    };

    this.alertsRef.child(alertObj.id).set(alertObj).catch(console.error);
    this.toast("🚨 LEAK CONFIRMED - Pump stopped automatically", "error");
  }

  async resolveAlert(id) {
    try {
      await this.alertsRef.child(id).update({
        resolved: true,
        resolvedAt: new Date().toISOString(),
      });
      this.toast("✅ Alert resolved", "success");
    } catch (err) {
      this.toast(`Failed to resolve alert: ${err.message}`, "error");
    }
  }

  renderAlerts() {
    const list = document.getElementById("alertsList");
    const counter = document.getElementById("alertCountText");
    if (!list) return;

    const active = this.alerts.filter((a) => !a.resolved);
    const resolved = this.alerts.filter((a) => a.resolved).slice(0, 5);

    if (counter) counter.textContent = `${active.length} Active`;

    const countEl = document.getElementById("alertCount");
    if (countEl) {
      countEl.className = `conn-indicator ${active.length > 0 ? "offline" : "online"}`;
    }

    if (this.alerts.length === 0) {
      list.innerHTML =
        '<div class="no-alerts">✅ No active alerts - system operating normally</div>';
      return;
    }

    list.innerHTML = [...active, ...resolved]
      .map(
        (a) => `
            <div class="alert-item ${a.severity?.toLowerCase() === "high" ? "high" : ""} ${a.resolved ? "resolved" : ""}">
                <div>
                    <h4>${a.title}</h4>
                    <div class="alert-msg">${a.message}</div>
                    <div class="alert-time">
                        ${new Date(a.timestamp).toLocaleString()}
                        ${a.resolved ? ` → Resolved ${new Date(a.resolvedAt).toLocaleTimeString()}` : ""}
                    </div>
                </div>
                ${!a.resolved ? `<button class="btn-resolve" onclick="dashboard.resolveAlert('${a.id}')">Resolve</button>` : ""}
            </div>
        `,
      )
      .join("");
  }

  // ══════════════════════════════════════════════════
  // DAILY LOG  (local accumulation in Firebase)
  // ══════════════════════════════════════════════════
  logDailyData(data) {
    const today = new Date().toISOString().split("T")[0];
    const supplied = parseFloat((data.sourceTotalLiters || 0).toFixed(1));
    const delivered = parseFloat((data.destTotalLiters || 0).toFixed(1));
    const loss = parseFloat((data.literDifference || 0).toFixed(1));

    // Only write if values are non-zero to avoid blanking out a real day
    if (supplied > 0 || delivered > 0) {
      this.dailyLogRef
        .child(today)
        .set({
          date: today,
          supplied,
          delivered,
          loss,
        })
        .catch(() => {});
    }
  }

  loadConsumptionData() {
    if (!this.dailyLogRef) return;
    const days = parseInt(document.getElementById("periodSelect")?.value || 7);

    this.dailyLogRef.once("value", (snap) => {
      const raw = snap.val() || {};

      // Build a full date range so missing days appear as zero bars
      const entries = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().split("T")[0];
        entries.push(
          raw[key] || { date: key, supplied: 0, delivered: 0, loss: 0 },
        );
      }

      this.updateConsumptionChart(entries);
    });
  }

  // ══════════════════════════════════════════════════
  // LEAK STATE UI
  // ══════════════════════════════════════════════════
  updateLeakState(data) {
    const diffCard = document.getElementById("diffCard");
    const srcCard = document.getElementById("sourceCard");
    const countdown = document.getElementById("leakCountdownAlert");
    const diffBadge = document.getElementById("diffStatus");

    if (data.leakDetected) {
      if (diffCard) diffCard.classList.add("leak-alert");
      if (srcCard) srcCard.classList.add("leak-alert");
      if (diffBadge) {
        diffBadge.textContent = "LEAK DETECTED";
        diffBadge.className = "kpi-badge offline";
      }
      if (countdown) countdown.style.display = "none";
      this.stopLeakCountdown();
    } else if (data.potentialLeak && data.consecutiveLeakReadings > 0) {
      if (diffCard) diffCard.classList.remove("leak-alert");
      if (diffBadge) {
        diffBadge.textContent = "Potential Leak";
        diffBadge.className = "kpi-badge warning";
      }
      if (countdown) countdown.style.display = "block";
      this.startLeakCountdown(data.consecutiveLeakReadings);
    } else {
      if (diffCard) diffCard.classList.remove("leak-alert");
      if (srcCard) srcCard.classList.remove("leak-alert");
      if (diffBadge) {
        diffBadge.textContent = "Normal";
        diffBadge.className = "kpi-badge success";
      }
      if (countdown) countdown.style.display = "none";
      this.stopLeakCountdown();
    }
  }

  startLeakCountdown(readingCount) {
    const maxReadings = 5;
    const remaining = Math.max(0, maxReadings - readingCount);
    this.setText("countdownSeconds", remaining.toString());
    const bar = document.getElementById("countdownBar");
    if (bar) bar.style.width = `${(remaining / maxReadings) * 100}%`;
  }

  stopLeakCountdown() {
    clearInterval(this.leakCountdown);
    this.leakCountdown = null;
  }

  // ══════════════════════════════════════════════════
  // KPI CARD COLOURS
  // ══════════════════════════════════════════════════
  updateKPICardColors(data) {
    const srcBadge = document.getElementById("sourceStatus");
    const dstBadge = document.getElementById("destStatus");
    const srcFlow = data.sourceFlow || 0;
    const dstFlow = data.destFlow || 0;

    if (srcBadge) {
      srcBadge.textContent = srcFlow > 0.1 ? "Active" : "No Flow";
      srcBadge.className =
        srcFlow > 0.1 ? "kpi-badge success" : "kpi-badge offline";
    }
    if (dstBadge) {
      dstBadge.textContent = dstFlow > 0.1 ? "Active" : "No Flow";
      dstBadge.className =
        dstFlow > 0.1 ? "kpi-badge success" : "kpi-badge offline";
    }
  }

  // ══════════════════════════════════════════════════
  // PUMP UI
  // ══════════════════════════════════════════════════
  updatePumpUI(isOn) {
    const indicator = document.getElementById("pumpStatus");
    const badge = document.getElementById("pumpStatusBadge");
    const label = document.getElementById("pumpStatusText");
    const cls = isOn ? "online" : "offline";
    const text = isOn ? "Pump ON" : "Pump OFF";

    [indicator, badge].forEach((el) => {
      if (el) el.className = `conn-indicator ${cls}`;
    });
    if (label) label.textContent = text;
    if (badge) badge.textContent = text;
  }

  // ══════════════════════════════════════════════════
  // ESP32 / CONNECTION STATUS
  // ══════════════════════════════════════════════════
  updateESP32Status(online) {
    this.esp32Online = online;
    const el = document.getElementById("esp32StatusIndicator");
    const txt = document.getElementById("esp32StatusText");
    if (el) el.className = `conn-indicator ${online ? "online" : "offline"}`;
    if (txt) txt.textContent = online ? "ESP32 Online" : "ESP32 Offline";

    if (!online) this.clearSensorReadings();
  }

  updateConnectionUI(connected, labelText) {
    const el = document.getElementById("connectionStatus");
    const txt = document.getElementById("connText");
    if (el) el.className = `conn-indicator ${connected ? "online" : "offline"}`;
    if (txt) txt.textContent = labelText;
  }

  // ══════════════════════════════════════════════════
  // CHARTS
  // ══════════════════════════════════════════════════
  initCharts() {
    this.initFlowChart();
    this.initConsumptionChart();
  }

  initFlowChart() {
    const ctx = document.getElementById("flowChart");
    if (!ctx) return;

    this.flowChart = new Chart(ctx.getContext("2d"), {
      type: "line",
      data: {
        labels: [],
        datasets: [
          this.makeDataset("Source (L/min)", "#38bdf8", true),
          this.makeDataset("Destination (L/min)", "#fb923c", true),
          this.makeDataset("Src Total (L)", "#34d399", false, true),
          this.makeDataset("Dst Total (L)", "#a78bfa", false, true),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 200 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#111827",
            titleColor: "#94a3b8",
            bodyColor: "#f1f5f9",
            borderColor: "rgba(255,255,255,0.08)",
            borderWidth: 1,
          },
        },
        scales: {
          x: {
            grid: { color: "rgba(255,255,255,0.04)" },
            ticks: { color: "#475569", font: { size: 10 }, maxTicksLimit: 8 },
          },
          y: {
            grid: { color: "rgba(255,255,255,0.04)" },
            ticks: { color: "#475569", font: { size: 10 } },
            title: {
              display: true,
              text: "L/min",
              color: "#475569",
              font: { size: 10 },
            },
          },
          y1: {
            position: "right",
            grid: { drawOnChartArea: false },
            ticks: { color: "#475569", font: { size: 10 } },
            title: {
              display: true,
              text: "Litres (total)",
              color: "#475569",
              font: { size: 10 },
            },
          },
        },
      },
    });
  }

  makeDataset(label, color, fill = false, secondary = false) {
    return {
      label,
      data: [],
      borderColor: color,
      backgroundColor: fill ? `${color}22` : "transparent",
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.35,
      yAxisID: secondary ? "y1" : "y",
      fill,
    };
  }

  pushChartPoint(data, time) {
    const b = this.chartBuffer;
    const ts = time.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    b.labels.push(ts);
    b.srcFlow.push(data.sourceFlow || 0);
    b.dstFlow.push(data.destFlow || 0);
    b.srcTotal.push(data.sourceTotalLiters || 0);
    b.dstTotal.push(data.destTotalLiters || 0);

    if (b.labels.length > b.maxPoints) {
      b.labels.shift();
      b.srcFlow.shift();
      b.dstFlow.shift();
      b.srcTotal.shift();
      b.dstTotal.shift();
    }

    if (!this.flowChart) return;
    const { datasets } = this.flowChart.data;
    this.flowChart.data.labels = [...b.labels];
    datasets[0].data = [...b.srcFlow];
    datasets[1].data = [...b.dstFlow];
    datasets[2].data = [...b.srcTotal];
    datasets[3].data = [...b.dstTotal];
    this.flowChart.update("none");
  }

  clearChartBuffer() {
    const b = this.chartBuffer;
    b.labels = [];
    b.srcFlow = [];
    b.dstFlow = [];
    b.srcTotal = [];
    b.dstTotal = [];
    if (this.flowChart) {
      this.flowChart.data.labels = [];
      this.flowChart.data.datasets.forEach((d) => (d.data = []));
      this.flowChart.update();
    }
  }

  initConsumptionChart() {
    const ctx = document.getElementById("consumptionChart");
    if (!ctx) return;

    this.consumptionChart = new Chart(ctx.getContext("2d"), {
      type: "bar",
      data: {
        labels: [],
        datasets: [
          {
            label: "Supplied (L)",
            data: [],
            backgroundColor: "rgba(56,189,248,0.6)",
            borderColor: "#38bdf8",
            borderWidth: 1,
          },
          {
            label: "Delivered (L)",
            data: [],
            backgroundColor: "rgba(52,211,153,0.6)",
            borderColor: "#34d399",
            borderWidth: 1,
          },
          {
            label: "Loss (L)",
            data: [],
            backgroundColor: "rgba(248,113,113,0.6)",
            borderColor: "#f87171",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#94a3b8", font: { size: 11 } } },
          tooltip: {
            backgroundColor: "#111827",
            titleColor: "#94a3b8",
            bodyColor: "#f1f5f9",
            borderColor: "rgba(255,255,255,0.08)",
            borderWidth: 1,
          },
        },
        scales: {
          x: {
            grid: { color: "rgba(255,255,255,0.04)" },
            ticks: { color: "#475569", font: { size: 10 } },
          },
          y: {
            grid: { color: "rgba(255,255,255,0.04)" },
            ticks: { color: "#475569", font: { size: 10 } },
            title: {
              display: true,
              text: "Litres",
              color: "#475569",
              font: { size: 10 },
            },
          },
        },
      },
    });
  }

  updateConsumptionChart(data) {
    if (!this.consumptionChart || !data?.length) return;

    const labels = data.map((d) =>
      new Date(d.date).toLocaleDateString([], {
        month: "short",
        day: "numeric",
      }),
    );
    const supplied = data.map((d) => d.supplied || 0);
    const delivered = data.map((d) => d.delivered || 0);
    const loss = data.map((d) => d.loss || 0);

    this.consumptionChart.data.labels = labels;
    this.consumptionChart.data.datasets[0].data = supplied;
    this.consumptionChart.data.datasets[1].data = delivered;
    this.consumptionChart.data.datasets[2].data = loss;
    this.consumptionChart.update();

    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const avg = (arr) =>
      arr.length ? (sum(arr) / arr.length).toFixed(0) : "0";

    this.setText("avgSupply", `${avg(supplied)} L`);
    this.setText("avgDelivery", `${avg(delivered)} L`);
    this.setText("avgLoss", `${avg(loss)} L`);

    const totS = sum(supplied);
    const totL = sum(loss);
    this.setText(
      "periodLoss",
      `${totS > 0 ? ((totL / totS) * 100).toFixed(1) : "0.0"}%`,
    );
  }

  // ══════════════════════════════════════════════════
  // EVENT LISTENERS
  // ══════════════════════════════════════════════════
  setupEventListeners() {
    this.on("loginBtn", "click", () => this.showLoginModal());
    this.on("loginBtnHero", "click", () => this.showLoginModal());
    this.on("loginForm", "submit", (e) => this.handleLogin(e));
    this.on("logoutBtn", "click", () => this.handleLogout());
    this.on("pumpOnBtn", "click", () => this.controlPump("on"));
    this.on("pumpOffBtn", "click", () => this.controlPump("off"));
    this.on("resetSystemBtn", "click", () => this.resetSystem());
    this.on("periodSelect", "change", () => this.loadConsumptionData());
  }

  on(id, event, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
  }

  // ══════════════════════════════════════════════════
  // UTILITY
  // ══════════════════════════════════════════════════
  setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? "-.-";
  }

  setDisplay(id, value) {
    const el = document.getElementById(id);
    if (el) el.style.display = value;
  }

  resetDisplayValues() {
    [
      "sourceFlowValue",
      "destFlowValue",
      "sourceTotalValue",
      "destTotalValue",
      "flowDifferentialValue",
      "literDifferenceValue",
      "totalConsumptionValue",
      "lossPercentageValue",
    ].forEach((id) => this.setText(id, "-.-"));
    this.setText("systemStatusText", "Reset...");
  }

  clearSensorReadings() {
    [
      "sourceFlowValue",
      "destFlowValue",
      "sourceTotalValue",
      "destTotalValue",
      "flowDifferentialValue",
      "literDifferenceValue",
      "totalConsumptionValue",
      "lossPercentageValue",
      "systemUptimeDisplay",
      "systemUptime",
    ].forEach((id) => this.setText(id, "-.-"));
    this.setText("systemStatusText", "OFFLINE");

    ["sourceStatus", "destStatus", "diffStatus"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = "No Data";
        el.className = "kpi-badge offline";
      }
    });
  }

  formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m.toString().padStart(2, "0")}m`;
  }

  // ══════════════════════════════════════════════════
  // TOAST NOTIFICATIONS
  // ══════════════════════════════════════════════════
  createToastContainer() {
    const c = document.createElement("div");
    c.id = "toastContainer";
    c.className = "toast-container";
    document.body.appendChild(c);
  }

  toast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const icons = { success: "✅", error: "🔴", warning: "⚠️", info: "ℹ️" };
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.innerHTML = `<span>${icons[type] || "ℹ️"}</span><span>${message}</span>`;
    container.appendChild(t);
    setTimeout(() => {
      t.style.animation = "toastOut 0.3s ease forwards";
      setTimeout(() => t.remove(), 300);
    }, 5000);
  }
}

// ══════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════
let dashboard;
document.addEventListener("DOMContentLoaded", () => {
  dashboard = new WaterDashboard();
  window.dashboard = dashboard;
});

window.debugWater = () => {
  console.table({
    FirebaseDB: !!dashboard?.db,
    "Last Data": JSON.stringify(dashboard?.currentData, null, 2),
    Alerts: dashboard?.alerts?.length,
    ChartPoints: dashboard?.chartBuffer?.labels?.length,
  });
};
