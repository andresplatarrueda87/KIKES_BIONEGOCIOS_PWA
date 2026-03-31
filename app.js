// KIKES BIONEGOCIOS - PWA Core Logic
const CONFIG = {
    BROKER: 'wss://broker.emqx.io:8084/mqtt',
    ENCRYPTION_KEY: 'TwR4AUlhiTDyFZtaFnZXIoeGQYyvpHAIYxRY3tbg+rE=',
    TOPICS: {
        BASE: 'kikes/gw/#',
        STATUS: 'kikes/gw/bionegocios/status',
        OPCUA: 'kikes/gw/bionegocios/status/connection',
        HEARTBEAT: 'kikes/gw/bionegocios/status'
    }
};

// --- Security Module ---
const SecurityUtils = {
    decrypt(base64Payload) {
        if (!base64Payload) return { text: '', isEncrypted: false };

        try {
            // 1. Decode to WordArray
            const fullRaw = CryptoJS.enc.Base64.parse(base64Payload);
            // Must have at least IV (16 bytes)
            if (fullRaw.sigBytes < 16) return { text: base64Payload, isEncrypted: false };

            // 2. Extract IV (First 4 words = 16 bytes)
            const iv = CryptoJS.lib.WordArray.create(fullRaw.words.slice(0, 4), 16);

            // 3. Extract Ciphertext (The rest)
            const ciphertext = CryptoJS.lib.WordArray.create(fullRaw.words.slice(4), fullRaw.sigBytes - 16);

            // 4. Prepare Key (32 bytes = 8 words)
            const keyRaw = CryptoJS.enc.Base64.parse(CONFIG.ENCRYPTION_KEY);
            const key = CryptoJS.lib.WordArray.create(keyRaw.words.slice(0, 8), 32);

            // 5. Decrypt AES-256-CBC
            const decrypted = CryptoJS.AES.decrypt(
                { ciphertext: ciphertext },
                key,
                { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
            );

            // 6. Convert to UTF-8
            const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
            if (!decryptedText) {
                // If it looks like base64 but can't be decrypted, it might be raw data that just fits the profile
                return { text: base64Payload, isEncrypted: false };
            }

            return { text: decryptedText, isEncrypted: true };
        } catch (e) {
            return { text: base64Payload, isEncrypted: false };
        }
    }
};

// --- State Manager ---
const State = {
    isConnected: false,
    isGatewayOnline: false,
    isOpcUaConnected: false,
    plcStatuses: ['offline', 'offline', 'offline'],
    isPlcConnected: false,
    tanks: {
        bio1: { value: 0, fluid: 0, temp: 0, lastUpdate: 0, motors: [] },
        bio2: { value: 0, fluid: 0, temp: 0, lastUpdate: 0, motors: [] }
    },
    storage: { value: 0, lastUpdate: 0, motors: [], diagnostic: { timestamp: '', isRetained: false } },
    whirlpool: { value: 0, lastUpdate: 0, diagnostic: { timestamp: '', isRetained: false } },
    tanque25m: { value: 0, motor: false, local: false, falla: false, lastUpdate: 0, diagnostic: { timestamp: '', isRetained: false } },
    valvulas25m: { v1: false, v1Op: false, v1Cl: false, v2: false, v2Op: false, v2Cl: false, diagnostic: { timestamp: '', isRetained: false } },
    alivio1: { value: 0, lastUpdate: 0, diagnostic: { timestamp: '', isRetained: false } },
    alivio2: { value: 0, lastUpdate: 0, diagnostic: { timestamp: '', isRetained: false } },
    generador: { kw: 0, status: false, fault: false, lastUpdate: 0, diagnostic: { timestamp: '', isRetained: false } },
    teas: { 
        tea1: { status: false, fault: false, diagnostic: { timestamp: '', isRetained: false } }, 
        tea2: { status: false, fault: false }, 
        tea3: { status: false, fault: false }, 
        tea2y3_diag: { timestamp: '', isRetained: false },
        lastUpdate: 0
    },
    lastHeartbeat: 0,
    showDiagnostics: false,
    notificationsEnabled: false,
    lastAlarmStates: {}
};

// --- Notification Engine ---
const Notifications = {
    async requestPermission() {
        if (!('Notification' in window)) {
            alert('Este navegador no soporta notificaciones nativas.');
            return false;
        }

        if (!window.isSecureContext) {
            alert('ERROR: Las notificaciones requieren una conexión segura (HTTPS) o localhost para funcionar.');
            return false;
        }

        try {
            const permission = await Notification.requestPermission();
            if (permission === 'denied') {
                alert('Las notificaciones han sido bloqueadas. Debe habilitarlas manualmente en la configuración del navegador (sitio).');
                return false;
            }
            return permission === 'granted';
        } catch (e) {
            console.error('Error solicitando permisos:', e);
            return false;
        }
    },

    show(title, body) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;

        // Prefer showNotification via Service Worker for PWA compliance
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            navigator.serviceWorker.ready.then(registration => {
                registration.showNotification(title, {
                    body: body,
                    icon: 'kikes_bionegocios_pwa_icon.png',
                    vibrate: [200, 100, 200],
                    tag: 'tapa-alarm'
                });
            });
        } else {
            // Fallback for direct browser notification
            new Notification(title, {
                body: body,
                icon: 'egipto_agua_pwa_icon.png',
                vibrate: [200, 100, 200]
            });
        }
    }
};

// --- UI Engine ---
const UI = {
    init() {
        this.updateStatus();
        this.setupEventListeners();
        this.loadSettings();
        this.updateDashboard(); // Initial refresh with stored settings
    },

    loadSettings() {
        const diag = localStorage.getItem('diag') === 'true';
        State.showDiagnostics = diag;
        document.getElementById('chk-diagnostics').checked = diag;

        const notify = localStorage.getItem('notify') === 'true';
        State.notificationsEnabled = notify;
        document.getElementById('chk-notifications').checked = notify;
    },


    updateStatus() {
        const indicator = document.getElementById('status-indicator');
        const miniPlcs = document.getElementById('header-mini-plcs');
        const header = document.querySelector('header');
        const mainStatus = document.getElementById('system-status');
        const label = indicator.querySelector('.label');
        const dot = indicator.querySelector('.dot');
        const statusBox = mainStatus.querySelector('.status-text');
        const statusIcon = mainStatus.querySelector('.icon');

        const isCollapsed = header.classList.contains('hide-sub');

        // Broker state is the absolute base
        if (!State.isConnected) {
            indicator.className = 'status-indicator offline';
            label.innerText = 'BROKER OFFLINE';
            if (miniPlcs) miniPlcs.classList.add('hidden');
        } else {
            // Broker is Online
            if (isCollapsed) {
                // In collapsed mode, the main dot and label reflect the Gateway
                const isGwOnline = State.isGatewayOnline;
                indicator.className = 'status-indicator ' + (isGwOnline ? 'online' : 'offline');
                label.innerText = isGwOnline ? 'GW ONLINE' : 'GW OFFLINE';
                
                if (miniPlcs) {
                    miniPlcs.classList.remove('hidden');
                    // Update mini dots
                    State.plcStatuses.forEach((status, i) => {
                        const miniDot = miniPlcs.querySelector(`#mini-dot-${i}`);
                        if (miniDot) miniDot.className = 'mini-dot-h ' + (status === 'online' ? 'online' : 'offline');
                    });
                }
            } else {
                // At top, main dot and label reflect the Broker
                indicator.className = 'status-indicator online';
                label.innerText = 'BROKER ONLINE';
                if (miniPlcs) miniPlcs.classList.add('hidden');
            }
        }

        // Update main PLC dots (the big ones in the card)
        State.plcStatuses.forEach((status, i) => {
            const plcDot = document.getElementById(`plc-dot-${i}`);
            if (plcDot) {
                // If Gateway is offline, force dots to offline
                const effectiveStatus = (State.isConnected && State.isGatewayOnline) ? status : 'offline';
                plcDot.className = 'plc-status-dot ' + (effectiveStatus === 'online' ? 'online' : 'offline');
            }
        });

        if (!State.isConnected) {
            mainStatus.style.borderColor = 'var(--accent-red)';
            mainStatus.style.background = 'rgba(248, 81, 73, 0.1)';
            statusIcon.innerText = '⚠️';
            statusBox.innerHTML = '<h3 style="color:var(--accent-red)">BROKER OFFLINE</h3>';
        } else if (State.isGatewayOnline) {
            mainStatus.style.borderColor = 'var(--accent-green)';
            mainStatus.style.background = 'rgba(63, 185, 80, 0.1)';
            statusIcon.innerText = '✅';
            statusBox.innerHTML = '<h3 style="color:var(--accent-green)">GATEWAY ONLINE</h3>';
        } else {
            mainStatus.style.borderColor = 'var(--accent-red)';
            mainStatus.style.background = 'rgba(248, 81, 73, 0.1)';
            statusIcon.innerText = '⚠️';
            statusBox.innerHTML = '<h3 style="color:var(--accent-red)">GATEWAY OFFLINE</h3>';
        }
    },

    formatVal(val, decimals = 1) {
        const n = parseFloat(val);
        return isNaN(n) ? '--' : n.toFixed(decimals);
    },

    updateDashboard() {
        this.updateTanks();
        this.updateAlivios();
        this.updateValves25m();
        this.updateGenerador();
        this.updateTeas();
    },

    updateTanks() {
        // BIO 1
        const t1 = State.tanks.bio1;
        document.getElementById('txt-tank-top-1').innerText = this.formatVal(t1.value);
        if (document.getElementById('txt-temp-1')) {
            document.getElementById('txt-temp-1').innerText = this.formatVal(t1.temp);
        }
        document.getElementById('txt-tank-1').innerText = this.formatVal(t1.fluid);
        const bar1 = document.getElementById('tank-bar-1');
        if (bar1) bar1.style.height = Math.min(100, Math.max(0, t1.fluid)) + '%';

        // BIO 2
        const t2 = State.tanks.bio2;
        document.getElementById('txt-tank-top-2').innerText = this.formatVal(t2.value);
        if (document.getElementById('txt-temp-2')) {
            document.getElementById('txt-temp-2').innerText = this.formatVal(t2.temp);
        }
        document.getElementById('txt-tank-2').innerText = this.formatVal(t2.fluid);
        const bar2 = document.getElementById('tank-bar-2');
        if (bar2) bar2.style.height = Math.min(100, Math.max(0, t2.fluid)) + '%';

        this.updateStorage();
        this.updateMotors();
        this.updateTanque25m();

        // Diagnostics (plcIndex: 0 = PLC 1, 1 = PLC 2)
        this.updateDiagnostics('bio1-diag', '@/kikes/bionegocios/BD1', State.tanks.bio1.diagnostic || { value: '', timestamp: '', isRetained: false }, 0);
        this.updateDiagnostics('bio2-diag', '@/kikes/bionegocios/BD2', State.tanks.bio2.diagnostic || { value: '', timestamp: '', isRetained: false }, 1);
    },

    updateMotors() {
        // Accept '1', 'true', 'True', true as ON
        const isOn = s => s === 1 || s === '1' || String(s).toLowerCase() === 'true';

        // BIO 1 (AGT1-5)
        const b1 = State.tanks.bio1.motors;
        if (b1 && b1.length > 0) {
            b1.forEach((s, i) => {
                const img = document.getElementById(`img-agt-${i + 1}`);
                if (img) {
                    const on = isOn(s);
                    img.src = on ? 'images/Motor_On.png' : 'images/Motor_Off.png';
                    img.className = 'motor-img' + (on ? ' on' : '');
                }
            });
        }

        // BIO 2 (M1-4)
        const b2 = State.tanks.bio2.motors;
        if (b2 && b2.length > 0) {
            b2.forEach((s, i) => {
                const img = document.getElementById(`img-m-${i + 1}`);
                if (img) {
                    const on = isOn(s);
                    img.src = on ? 'images/Motor_On.png' : 'images/Motor_Off.png';
                    img.className = 'motor-img' + (on ? ' on' : '');
                }
            });
        }
    },

    updateStorage() {
        const s = State.storage;
        const topEl = document.getElementById('txt-storage-top');
        const barEl = document.getElementById('storage-bar');

        if (topEl) topEl.innerText = this.formatVal(s.value);
        if (barEl) barEl.style.height = Math.min(100, Math.max(0, s.value)) + '%';

        // Update Pre-Storage Motors (M11, M17)
        const isOn = val => val === 1 || val === '1' || String(val).toLowerCase() === 'true';
        const motors = [
            { id: 'm11', val: s.motors[1] },
            { id: 'm17', val: s.motors[2] }
        ];

        motors.forEach(m => {
            const img = document.getElementById(`img-${m.id}`);
            if (img) {
                if (m.id === 'm17') {
                    img.src = 'images/Motor_Fault.png';
                    img.className = 'motor-img';
                    img.style.filter = 'grayscale(0) opacity(1) drop-shadow(0 0 10px #f85149) brightness(1.2)';
                } else {
                    const on = isOn(m.val);
                    img.src = on ? 'images/Motor_On.png' : 'images/Motor_Off.png';
                    img.className = 'motor-img' + (on ? ' on' : '');
                }
            }
        });

        this.updateWhirlpool();

        // Diagnostics
        this.updateDiagnostics('storage-diag', '@/kikes/bionegocios/PreStorage', State.storage.diagnostic, 0);
    },

    updateWhirlpool() {
        const w = State.whirlpool;
        const topEl = document.getElementById('txt-whirl-top');
        const barEl = document.getElementById('whirl-bar');

        if (topEl) topEl.innerText = this.formatVal(w.value);
        if (barEl) barEl.style.height = Math.min(100, Math.max(0, w.value)) + '%';

        // Diagnostics
        this.updateDiagnostics('whirlpool-diag', '@/kikes/bionegocios/Whirlpool', State.whirlpool.diagnostic, 0);
    },

    updateTanque25m() {
        const t = State.tanque25m;
        const topEl = document.getElementById('txt-tanque25m-top');
        const barEl = document.getElementById('tanque25m-bar');

        if (topEl) topEl.innerText = this.formatVal(t.value);
        if (barEl) barEl.style.height = Math.min(100, Math.max(0, t.value)) + '%';

        const isOn = val => val === 1 || val === '1' || String(val).toLowerCase() === 'true';
        const imgPump = document.getElementById('img-m25');
        const lblLocal = document.getElementById('lbl-m25-local');
        const lblFalla = document.getElementById('lbl-m25-falla');

        if (imgPump) {
            const on = isOn(t.motor);
            imgPump.src = on ? 'images/pump_green.png' : 'images/pump_gray.png';
            imgPump.className = 'motor-img' + (on ? ' on' : '');
        }
        
        if (lblLocal) {
            if (isOn(t.local)) {
                lblLocal.classList.remove('hidden');
            } else {
                lblLocal.classList.add('hidden');
            }
        }
        
        if (lblFalla) {
            if (isOn(t.falla)) {
                lblFalla.classList.remove('hidden');
            } else {
                lblFalla.classList.add('hidden');
            }
        }

        // Diagnostics
        this.updateDiagnostics('tanque25m-diag', '@/kikes/bionegocios/Tanque25', t.diagnostic, 0);
    },

    updateValves25m() {
        const v = State.valvulas25m;
        const imgV1 = document.getElementById('img-v25-1');
        const imgV2 = document.getElementById('img-v25-2');

        if (imgV1) {
            imgV1.src = v.v1 ? 'images/Valvula_On.png' : 'images/Valvula_Off.png';
            imgV1.className = 'motor-img' + (v.v1 ? ' on' : '');
            
            const ledOp = document.getElementById('led-v1-op');
            const ledCl = document.getElementById('led-v1-cl');
            if(ledOp) ledOp.style.backgroundColor = v.v1Op ? 'var(--accent-green)' : '#444';
            if(ledCl) ledCl.style.backgroundColor = v.v1Cl ? 'var(--accent-green)' : '#444';
        }

        if (imgV2) {
            imgV2.src = v.v2 ? 'images/Valvula_On.png' : 'images/Valvula_Off.png';
            imgV2.className = 'motor-img' + (v.v2 ? ' on' : '');
            
            const ledOp = document.getElementById('led-v2-op');
            const ledCl = document.getElementById('led-v2-cl');
            if(ledOp) ledOp.style.backgroundColor = v.v2Op ? 'var(--accent-green)' : '#444';
            if(ledCl) ledCl.style.backgroundColor = v.v2Cl ? 'var(--accent-green)' : '#444';
        }

        this.updateDiagnostics('valvulas25m-diag', '@/kikes/bionegocios/Tanque25/Valvulas', v.diagnostic, 1);
    },

    updateAlivios() {
        // Alivio 1
        const a1 = State.alivio1;
        const topEl1 = document.getElementById('txt-alivio1-top');
        const barEl1 = document.getElementById('alivio1-bar');

        if (topEl1) topEl1.innerText = this.formatVal(a1.value);
        if (barEl1) barEl1.style.height = Math.min(100, Math.max(0, a1.value)) + '%';

        // Alivio 2
        const a2 = State.alivio2;
        const topEl2 = document.getElementById('txt-alivio2-top');
        const barEl2 = document.getElementById('alivio2-bar');

        if (topEl2) topEl2.innerText = this.formatVal(a2.value);
        if (barEl2) barEl2.style.height = Math.min(100, Math.max(0, a2.value)) + '%';

        this.updateDiagnostics('alivio1-diag', '@/kikes/bionegocios/Alivio1', a1.diagnostic, 0);
        this.updateDiagnostics('alivio2-diag', '@/kikes/bionegocios/Alivio2', a2.diagnostic, 1);
    },

    updateGenerador() {
        const g = State.generador;
        const valEl = document.getElementById('txt-generador-val');
        const barEl = document.getElementById('generador-bar');
        const imgEl = document.getElementById('img-generador');

        if (valEl) valEl.innerText = this.formatVal(g.kw);
        if (barEl) barEl.style.width = Math.min(100, Math.max(0, g.kw / 10)) + '%';

        const isOn = val => val === 1 || val === '1' || String(val).toLowerCase() === 'true';
        if (imgEl) {
            const statusOn = isOn(g.status);
            const faultOn = isOn(g.fault);

            if (faultOn) {
                imgEl.src = 'images/Generator_Fault.png';
                imgEl.className = 'storage-img fault-glow';
            } else {
                imgEl.src = statusOn ? 'images/Generator_On.png' : 'images/Generator_Off.png';
                imgEl.className = 'storage-img' + (statusOn ? ' motor-on-glow' : '');
            }
        }

        this.updateDiagnostics('generador-diag', '@/kikes/bionegocios/Generador', g.diagnostic, 0);
    },

    updateTeas() {
        const t = State.teas;
        const isOn = val => val === 1 || val === '1' || String(val).toLowerCase() === 'true';
        
        const updateSingleTea = (id, data) => {
            const img = document.getElementById(`img-tea-${id}`);
            if (!img) return;
            
            const statusOn = isOn(data.status);
            const faultOn = isOn(data.fault);
            
            if (faultOn) {
                img.src = 'images/TEA_Fault.png';
                img.className = 'motor-img fault-glow';
            } else {
                img.src = statusOn ? 'images/TEA_On.png' : 'images/TEA_Off.png';
                img.className = 'motor-img' + (statusOn ? ' motor-on-glow' : '');
            }
        };

        updateSingleTea(1, t.tea1);
        updateSingleTea(2, t.tea2);
        updateSingleTea(3, t.tea3);

        this.updateDiagnostics('tea1-diag', '@/kikes/bionegocios/TEA1', t.tea1.diagnostic, 0);
        this.updateDiagnostics('tea2y3-diag', '@/kikes/bionegocios/TEA2Y3', t.tea2y3_diag, 1);
    },

    updateDiagnostics(containerId, topic, dataObj, plcIndex = -1) {
        let container = document.getElementById(containerId);

        if (!container) {
            const target = document.getElementById(containerId.replace('-diag', ''));
            if (!target) return;

            container = document.createElement('div');
            container.id = containerId;
            container.className = 'diagnostic-badge-root';
            target.prepend(container);
        }

        // Determine diagnostic state
        let badgeClass, badgeText;
        const now = Date.now();
        const isStale = dataObj.receivedAt ? (now - dataObj.receivedAt > 60000) : false;
        const isPlcNodeOffline = (plcIndex >= 0) ? (State.plcStatuses[plcIndex] !== 'online') : !State.isPlcConnected;

        if (!dataObj.timestamp) {
            // No timestamp = never received data
            badgeClass = 'diag-offline';
            badgeText = '⊘ OFFLINE';
        } else if (dataObj.isRetained || !State.isGatewayOnline || isPlcNodeOffline || isStale) {
            badgeClass = 'diag-retained';
            badgeText = '⚠ RETENIDO';
        } else {
            badgeClass = 'diag-live';
            badgeText = '● LIVE';
        }

        const isHealthy = badgeClass === 'diag-live';
        const showFull = State.showDiagnostics;
        const showMinimal = !showFull && !isHealthy;

        // Hide entirely if diagnostics are off AND the topic is perfectly healthy 'LIVE'
        if (!showFull && isHealthy) {
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');

        if (showFull) {
            container.className = 'diagnostic-badge-root';
            // Localize timestamp
            let timeDisplay = '';
            if (dataObj.timestamp) {
                try {
                    const date = new Date(dataObj.timestamp);
                    timeDisplay = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                } catch (e) { timeDisplay = dataObj.timestamp; }
            }

            container.innerHTML = `
                <div class="diag-topic">${topic}</div>
                <div class="diag-meta">
                    <span class="diag-status ${badgeClass}">${badgeText}</span>
                    ${timeDisplay ? `<span class="diag-time">🕒 ${timeDisplay}</span>` : ''}
                </div>
            `;
        } else if (showMinimal) {
            container.className = 'diagnostic-badge-root minimal-diag';
            const minimalText = badgeClass === 'diag-retained' ? '⚠' : (badgeClass === 'diag-offline' ? '⊘' : badgeText);
            container.innerHTML = `<span class="diag-status ${badgeClass}">${minimalText}</span>`;
        }
    },


    setupEventListeners() {
        document.getElementById('btn-settings').onclick = () => document.getElementById('settings-panel').classList.remove('hidden');
        document.getElementById('close-settings').onclick = () => document.getElementById('settings-panel').classList.add('hidden');

        // Header Visibility Logic (Simple: Show only at top)
        const header = document.querySelector('header');
        window.addEventListener('scroll', () => {
            const isTop = window.scrollY <= 20;
            const wasCollapsed = header.classList.contains('hide-sub');
            
            if (isTop) {
                header.classList.remove('hide-sub');
            } else {
                header.classList.add('hide-sub');
            }

            // If the state changed, refresh the status labels/mini-dots
            if (wasCollapsed !== header.classList.contains('hide-sub')) {
                this.updateStatus();
            }
        }, { passive: true });

        document.getElementById('chk-diagnostics').onchange = (e) => {
            State.showDiagnostics = e.target.checked;
            localStorage.setItem('diag', e.target.checked);
            this.updateDashboard(); // Force UI update immediately
        };

        document.getElementById('chk-notifications').onchange = async (e) => {
            if (e.target.checked) {
                const granted = await Notifications.requestPermission();
                if (!granted) {
                    e.target.checked = false;
                    State.notificationsEnabled = false;
                } else {
                    State.notificationsEnabled = true;
                }
                localStorage.setItem('notify', State.notificationsEnabled);
            } else {
                State.notificationsEnabled = false;
                localStorage.setItem('notify', 'false');
            }
        };
    }
};

// --- MQTT Engine ---
const MQTT = {
    client: null,

    connect() {
        console.log('Connecting to MQTT...');
        const activeTopic = 'kikes/gw/bionegocios/active_client';

        this.client = mqtt.connect(CONFIG.BROKER, {
            clientId: 'KikesBioPWA_' + Math.random().toString(16).substring(2, 8),
            keepalive: 60,
            clean: true,
            will: {
                topic: activeTopic,
                payload: 'false',
                qos: 1,
                retain: true
            }
        });

        this.client.on('connect', () => {
            console.log('Connected to Broker ✓');
            State.isConnected = true;
            UI.updateStatus();

            this.publishActive(true);

            this.client.subscribe(CONFIG.TOPICS.BASE);
            this.client.subscribe(CONFIG.TOPICS.STATUS);
            this.client.subscribe(CONFIG.TOPICS.OPCUA);
            this.client.subscribe(CONFIG.TOPICS.HEARTBEAT);
            this.client.subscribe('@/kikes/bionegocios/BD1');
            this.client.subscribe('@/kikes/bionegocios/BD2');
            this.client.subscribe('@/kikes/bionegocios/BD1/Motors');
            this.client.subscribe('@/kikes/bionegocios/BD2/Motors');
            this.client.subscribe('@/kikes/bionegocios/PreStorage');
            this.client.subscribe('@/kikes/bionegocios/Whirlpool');
            this.client.subscribe('@/kikes/bionegocios/Tanque25');
            this.client.subscribe('@/kikes/bionegocios/Tanque25/Valvulas');
            this.client.subscribe('@/kikes/bionegocios/Alivio1');
            this.client.subscribe('@/kikes/bionegocios/Alivio2');
            this.client.subscribe('@/kikes/bionegocios/Generador');
            this.client.subscribe('@/kikes/bionegocios/TEA1');
            this.client.subscribe('@/kikes/bionegocios/TEA2Y3');
            this.client.subscribe('kikes/gw/bionegocios/cmd/ping');
        });

        this.client.on('message', (topic, payload, packet) => {
            const topicLower = topic.toLowerCase();
            const message = payload.toString();
            this.handleMessage(topicLower, message, packet);
        });

        this.client.on('close', () => {
            State.isConnected = false;
            UI.updateStatus();
        });

        // Toggle active state based on tab visibility
        document.addEventListener('visibilitychange', () => {
            this.publishActive(document.visibilityState === 'visible');
        });
    },

    publishActive(isActive) {
        if (!this.client || !this.client.connected) return;
        const topic = 'kikes/gw/bionegocios/active_client';
        const payload = isActive ? 'true' : 'false';
        this.client.publish(topic, payload, { qos: 1, retain: true });
        console.log(`[MQTT] Client Active State published: ${payload}`);
    },

    handleMessage(topic, rawPayload, packet) {
        const encryptedTopics = ['bd1', 'bd2', 'prestorage', 'whirlpool', 'tanque25', 'alivio1', 'alivio2', 'generador', 'tea1', 'tea2y3'];
        const isProcessData = encryptedTopics.some(t => topic.includes(t));

        let currentPayload = rawPayload;
        let isRetained = packet ? packet.retain : false;
        let msgTimestamp = '';

        // 1. Optional Decryption
        if (isProcessData) {
            const result = SecurityUtils.decrypt(rawPayload);
            currentPayload = result.text;
        }

        // 2. JSON Extraction
        let finalValue = currentPayload;
        try {
            if (currentPayload.trim().startsWith('{')) {
                const json = JSON.parse(currentPayload);
                if (json.value !== undefined) finalValue = String(json.value);
                if (json.timestamp) msgTimestamp = json.timestamp;
            }
        } catch (e) { }

        // 3. Diagnostic Fallback: If we have data but no timestamp, assume it's live data
        if (!msgTimestamp && finalValue) {
            msgTimestamp = new Date().toISOString();
        }

        const dataObj = { 
            value: finalValue, 
            timestamp: msgTimestamp, 
            isRetained: isRetained,
            receivedAt: Date.now() 
        };
        this.processData(topic.toLowerCase(), dataObj);
        this.handleAlarms(topic.toLowerCase(), finalValue, isRetained);
        UI.updateDashboard();
    },

    handleAlarms(topic, payload, isRetained) {
        // Reserved for future tank level alarms
    },

    processData(topic, dataObj) {
        const now = Date.now();
        const payload = typeof dataObj.value === 'string' ? dataObj.value.replace(/,/g, '.') : dataObj.value;

        // Status topics
        if (topic.endsWith('kikes/gw/bionegocios/status')) {
            try {
                const data = JSON.parse(payload);
                const isOnline = data.status === 'online' || data.status === 'connected';
                
                if (isOnline && data.ts) {
                    const msgTime = new Date(data.ts).getTime();
                    const now = Date.now();
                    const diffSec = (now - msgTime) / 1000;

                    // Validation: Max 60 seconds of difference (Gateway clock vs Local clock)
                    if (diffSec > 60) {
                        console.warn(`[MQTT] Heartbeat rejected: Signal is too old (${diffSec.toFixed(1)}s). Marking as OFFLINE.`);
                        State.isGatewayOnline = false;
                    } else {
                        State.isGatewayOnline = true;
                        State.lastHeartbeat = now;
                        State.isPlcConnected = true;
                    }
                } else {
                    State.isGatewayOnline = isOnline;
                    if (isOnline) {
                        State.lastHeartbeat = now;
                    } else {
                        // Global offline: Reset PLC statuses
                        State.plcStatuses = State.plcStatuses.map(() => 'offline');
                        State.isOpcUaConnected = false;
                    }
                }
            } catch (e) {
                State.isGatewayOnline = payload.includes('online') || payload === '1' || payload === 'true';
                if (State.isGatewayOnline) State.lastHeartbeat = now;
            }
            UI.updateStatus();
            return; // Status handled, don't process as data
        } else if (topic.endsWith('kikes/gw/bionegocios/status/connection')) {
            try {
                // Consolidated status: "online|offline|online"
                const parts = payload.split('|');
                State.plcStatuses = parts.map(s => s.trim().toLowerCase());
                // Consider connected if at least one is online
                State.isOpcUaConnected = State.plcStatuses.some(s => s === 'online');
            } catch (e) {
                State.isOpcUaConnected = payload.includes('online');
            }
            UI.updateStatus();
            return; // Status handled, don't process as data
        }

        // Process data
        if (topic.includes('bionegocios/bd1/motors')) {
            if (payload.includes('|')) {
                State.tanks.bio1.motors = payload.split('|');
                UI.updateTanks();
            }
        } else if (topic.includes('bionegocios/bd2/motors')) {
            if (payload.includes('|')) {
                State.tanks.bio2.motors = payload.split('|');
                UI.updateTanks();
            }
        } else if (topic.includes('bionegocios/bd1')) {
            if (payload.includes('|')) {
                const parts = payload.split('|');
                State.tanks.bio1.value = parseFloat(parts[0]) || 0; 
                State.tanks.bio1.fluid = parseFloat(parts[1]) || 0; 
                State.tanks.bio1.temp = parseFloat(parts[2]) || 0;
                State.tanks.bio1.lastUpdate = now;
                State.tanks.bio1.diagnostic = dataObj;
                UI.updateTanks();
            }
        } else if (topic.includes('bionegocios/bd2')) {
            if (payload.includes('|')) {
                const parts = payload.split('|');
                State.tanks.bio2.value = parseFloat(parts[0]) || 0; 
                State.tanks.bio2.fluid = parseFloat(parts[1]) || 0; 
                State.tanks.bio2.temp = parseFloat(parts[2]) || 0;
                State.tanks.bio2.lastUpdate = now;
                State.tanks.bio2.diagnostic = dataObj;
                UI.updateTanks();
            }
        } else if (topic.includes('bionegocios/prestorage')) {
            if (payload.includes('|')) {
                const parts = payload.split('|');
                State.storage.value = parseFloat(parts[0]) || 0;
                State.storage.motors = parts; // [Level, M11, M17]
                State.storage.lastUpdate = now;
                State.storage.diagnostic = dataObj;
                UI.updateStorage();
            }
        } else if (topic.includes('bionegocios/whirlpool')) {
            State.whirlpool.value = parseFloat(payload) || 0;
            State.whirlpool.lastUpdate = now;
            State.whirlpool.diagnostic = dataObj;
            UI.updateWhirlpool();
        } else if (topic.includes('bionegocios/tanque25/valvulas')) {
            if (payload.includes('|')) {
                const parts = payload.split('|');
                const isOn = val => val === 1 || val === '1' || String(val).toLowerCase() === 'true';
                State.valvulas25m.v1 = isOn(parts[0]);
                State.valvulas25m.v1Op = isOn(parts[1]);
                State.valvulas25m.v1Cl = isOn(parts[2]);
                State.valvulas25m.v2 = isOn(parts[3]);
                State.valvulas25m.v2Op = isOn(parts[4]);
                State.valvulas25m.v2Cl = isOn(parts[5]);
                State.valvulas25m.diagnostic = dataObj;
                UI.updateValves25m();
            }
        } else if (topic.includes('bionegocios/tanque25')) {
            if (payload.includes('|')) {
                const parts = payload.split('|');
                State.tanque25m.value = parseFloat(parts[0]) || 0;
                State.tanque25m.motor = parts[1];
                State.tanque25m.local = parts[2];
                State.tanque25m.falla = parts[3];
                State.tanque25m.lastUpdate = now;
                State.tanque25m.diagnostic = dataObj;
                UI.updateTanque25m();
            }
        } else if (topic.includes('bionegocios/alivio1')) {
            State.alivio1.value = parseFloat(payload) || 0;
            State.alivio1.lastUpdate = now;
            State.alivio1.diagnostic = dataObj;
            UI.updateAlivios();
        } else if (topic.includes('bionegocios/alivio2')) {
            State.alivio2.value = parseFloat(payload) || 0;
            State.alivio2.lastUpdate = now;
            State.alivio2.diagnostic = dataObj;
            UI.updateAlivios();
        } else if (topic.includes('bionegocios/generador')) {
            if (payload.includes('|')) {
                const parts = payload.split('|');
                State.generador.kw = parseFloat(parts[0]) || 0;
                State.generador.status = parts[1];
                State.generador.fault = parts[2];
                State.generador.lastUpdate = now;
                State.generador.diagnostic = dataObj;
                UI.updateGenerador();
            }
        } else if (topic.includes('bionegocios/tea1')) {
            if (payload.includes('|')) {
                const parts = payload.split('|');
                State.teas.tea1.status = parts[0];
                State.teas.tea1.fault = parts[1];
                State.teas.tea1.diagnostic = dataObj;
                State.teas.lastUpdate = now;
                UI.updateTeas();
            }
        } else if (topic.includes('bionegocios/tea2y3')) {
            if (payload.includes('|')) {
                const parts = payload.split('|');
                State.teas.tea2.status = parts[0];
                State.teas.tea2.fault = parts[1];
                State.teas.tea3.status = parts[2];
                State.teas.tea3.fault = parts[3];
                State.teas.tea2y3_diag = dataObj;
                State.teas.lastUpdate = now;
                UI.updateTeas();
            }
        } else if (topic.includes('kikes/gw/bionegocios/cmd/ping')) {
            // Strategy 2: If we receive a ping, we must immediately assert we are active (if we are visible)
            if (document.visibilityState === 'visible') {
                this.publishActive(true);
            }
        }
    }
};

// --- Watchdog ---
setInterval(() => {
    const now = Date.now();
    // Watchdog: If no heartbeat in 60s, mark gateway and PLC as offline
    if (State.isGatewayOnline && (now - State.lastHeartbeat > 60000)) {
        console.warn('[Watchdog] Heartbeat lost. Gateway marked as offline.');
        State.isGatewayOnline = false;
        State.isPlcConnected = false;
        UI.updateStatus();
    }
    
    // Refresh diagnostics UI to visually show "RETENIDO" if data becomes stale
    if (State.showDiagnostics) {
        UI.updateDashboard();
    }
}, 5000);

// Init
UI.init();
MQTT.connect();
