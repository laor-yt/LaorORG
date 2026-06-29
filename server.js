const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');
const https = require('https');

function syncToGitHub(filename, dataObj) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return; // Only sync if token is provided

    const content = Buffer.from(JSON.stringify(dataObj, null, 2)).toString('base64');
    const repo = 'laor-yt/LaorORG'; // Assumes repository name based on user input
    const reqPath = filename; // Path is at the root of the repo, not Dashboard/


    const getOptions = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${reqPath}`,
        method: 'GET',
        headers: {
            'User-Agent': 'Render-Node-App',
            'Authorization': `token ${token}`
        }
    };

    https.request(getOptions, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
            let sha = '';
            if (res.statusCode === 200) {
                sha = JSON.parse(body).sha;
            }
            const putData = JSON.stringify({
                message: `Auto-sync ${filename} from Render`,
                content: content,
                sha: sha || undefined
            });
            const putOptions = {
                hostname: 'api.github.com',
                path: `/repos/${repo}/contents/${reqPath}`,
                method: 'PUT',
                headers: {
                    'User-Agent': 'Render-Node-App',
                    'Authorization': `token ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(putData)
                }
            };
            const req = https.request(putOptions, (resPut) => {
                console.log(`Synced ${filename} to GitHub. Status: ${resPut.statusCode}`);
            });
            req.on('error', (e) => console.error(`Error syncing ${filename}:`, e));
            req.write(putData);
            req.end();
        });
    }).on('error', (e) => {
        console.error(`Error getting SHA for ${filename}:`, e);
    }).end();
}


const app = express();
const PORT = 3000;
const UDP_PORT = 3041;
const DATA_FILE = path.join(__dirname, 'installations.json');
const ALLOWED_FILE = path.join(__dirname, 'allowed_emails.json');
const GLOBAL_STATUS_FILE = path.join(__dirname, 'global_status.json');
app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'text/csv' })); // Support parsing raw CSV text
app.use(express.static(path.join(__dirname, 'public')));

// Load allowed emails
function loadAllowedEmails() {
    try {
        if (fs.existsSync(ALLOWED_FILE)) {
            const data = JSON.parse(fs.readFileSync(ALLOWED_FILE, 'utf8'));
            // Normalize old string array to object format if necessary
            if (data.length > 0 && typeof data[0] === 'string') {
                const normalized = data.map(email => ({
                    email,
                    startDate: new Date().toISOString().split('T')[0],
                    endDate: new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0] // 1 year default
                }));
                saveAllowedEmails(normalized);
                return normalized;
            }
            return data;
        }
    } catch (e) {
        console.error('Error loading allowed emails:', e);
    }
    // Default allowed emails if the file doesn't exist yet
    const today = new Date().toISOString().split('T')[0];
    const nextYear = new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0];
    const defaults = [
        { email: "admin@laororg.local", startDate: today, endDate: nextYear },
        { email: "user@laororg.local", startDate: today, endDate: nextYear },
        { email: "test@gmail.com", startDate: today, endDate: nextYear }
    ];
    saveAllowedEmails(defaults);
    return defaults;
}

// Save allowed emails
function saveAllowedEmails(data) {
    try {
        fs.writeFileSync(ALLOWED_FILE, JSON.stringify(data, null, 2), 'utf8');
        syncToGitHub('allowed_emails.json', data);
    } catch (e) {
        console.error('Error saving allowed emails:', e);
    }
}

// Load installations
function loadInstallations() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading data:', e);
    }
    return [];
}

// Save installations
function saveInstallations(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
        syncToGitHub('installations.json', data);
    } catch (e) {
        console.error('Error saving data:', e);
    }
}

// Load global status
function loadGlobalStatus() {
    try {
        if (fs.existsSync(GLOBAL_STATUS_FILE)) {
            return JSON.parse(fs.readFileSync(GLOBAL_STATUS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading global status:', e);
    }
    const defaultStatus = { state: 'Running' };
    saveGlobalStatus(defaultStatus);
    return defaultStatus;
}

// Save global status
function saveGlobalStatus(data) {
    try {
        fs.writeFileSync(GLOBAL_STATUS_FILE, JSON.stringify(data, null, 2), 'utf8');
        syncToGitHub('global_status.json', data);
    } catch (e) {
        console.error('Error saving global status:', e);
    }
}

// Active peers discovered via UDP
let discoveredPeers = {};

// Register a new installation from Setup.au3
app.post('/api/register', (req, res) => {
    const { email, pcName, installPath } = req.body;
    if (!email || !pcName) {
        return res.status(400).json({ error: 'Missing email or pcName' });
    }

    let installations = loadInstallations();
    const existingIndex = installations.findIndex(i => i.email === email && i.pcName === pcName);
    
    const newInstall = {
        email,
        pcName,
        installPath,
        ipAddress: req.ip.replace('::ffff:', ''),
        registeredAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        status: 'Active'
    };

    if (existingIndex > -1) {
        installations[existingIndex] = { ...installations[existingIndex], ...newInstall };
    } else {
        installations.push(newInstall);
    }

    saveInstallations(installations);
    res.json({ success: true, message: 'Installation registered successfully' });
});

// Client polling check: called by LaorORG.exe -autopatch
app.get('/api/check-uninstall', (req, res) => {
    const { email, pc } = req.query;
    if (!email || !pc) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    let installations = loadInstallations();
    const item = installations.find(i => i.email.toLowerCase() === email.toLowerCase() && i.pcName.toLowerCase() === pc.toLowerCase());
    
    // Check if email has expired or is no longer whitelisted
    const allowed = loadAllowedEmails();
    const record = allowed.find(a => a.email.toLowerCase() === email.toLowerCase());
    const today = new Date().toISOString().split('T')[0];
    
    const isExpired = record && (today > record.endDate);
    const isDeleted = !record;
    
    if (isExpired || isDeleted) {
        if (item && item.status !== 'Uninstalled') {
            item.status = 'Pending Uninstall';
            item.lastActive = new Date().toISOString();
            saveInstallations(installations);
        }
        return res.json({ action: 'uninstall' });
    }

    if (item) {
        // Update last active timestamp
        item.lastActive = new Date().toISOString();
        saveInstallations(installations);

        if (item.status === 'Pending Uninstall') {
            return res.json({ action: 'uninstall' });
        }
        
        if (item.status === 'Stopped') {
            return res.json({ action: 'stop' });
        }
    }
    res.json({ action: 'none' });
});

// Client confirmation of uninstall completion: called by Uninstall.exe -silent
app.post('/api/confirm-uninstall', (req, res) => {
    const { email, pcName } = req.body;
    let installations = loadInstallations();
    const item = installations.find(i => i.email.toLowerCase() === email.toLowerCase() && i.pcName.toLowerCase() === pcName.toLowerCase());
    if (item) {
        item.status = 'Uninstalled';
        item.lastActive = new Date().toISOString();
        saveInstallations(installations);
    }
    res.json({ success: true });
});

// Setup verification endpoint: check if email is whitelisted, active, and has slots available
app.get('/api/check-email', (req, res) => {
    const { email, pc } = req.query;
    if (!email) {
        return res.status(400).json({ error: 'Missing email parameter' });
    }

    const allowed = loadAllowedEmails();
    const record = allowed.find(e => e.email.toLowerCase() === email.trim().toLowerCase());
    if (!record) {
        return res.json({ allowed: false, reason: 'unauthorized' });
    }

    // Verify subscription date bounds
    const today = new Date().toISOString().split('T')[0];
    if (today < record.startDate) {
        return res.json({ allowed: false, reason: 'not_started', startDate: record.startDate });
    }
    if (today > record.endDate) {
        return res.json({ allowed: false, reason: 'expired', endDate: record.endDate });
    }

    // Check installation count (max 2 active PCs per email)
    const installations = loadInstallations();
    const activeInstalls = installations.filter(i => 
        i.email.toLowerCase() === email.trim().toLowerCase() && 
        (i.status === 'Active' || i.status === 'Pending Uninstall') &&
        (!pc || i.pcName.toLowerCase() !== pc.trim().toLowerCase()) // Exclude the current PC to support re-installation
    );

    if (activeInstalls.length >= 2) {
        return res.json({ allowed: false, reason: 'limit_reached' });
    }

    res.json({ allowed: true });
});

// Dashboard: get allowed emails list
app.get('/api/allowed-emails', (req, res) => {
    res.json(loadAllowedEmails());
});

// Dashboard: add email to allowed list with custom start and end dates
app.post('/api/allowed-emails', (req, res) => {
    const { email, startDate, endDate } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'Missing email' });
    }
    
    let allowed = loadAllowedEmails();
    const trimmedEmail = email.trim();
    
    // Set default dates if empty
    const today = new Date().toISOString().split('T')[0];
    const nextMonth = new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0];
    
    const newAllowed = {
        email: trimmedEmail,
        startDate: startDate || today,
        endDate: endDate || nextMonth
    };
    
    const existingIndex = allowed.findIndex(e => e.email.toLowerCase() === trimmedEmail.toLowerCase());
    if (existingIndex > -1) {
        allowed[existingIndex] = newAllowed;
    } else {
        allowed.push(newAllowed);
    }
    
    saveAllowedEmails(allowed);
    res.json({ success: true, allowed });
});

// Dashboard: delete email from allowed list
app.delete('/api/allowed-emails', (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'Missing email' });
    }
    
    let allowed = loadAllowedEmails();
    const trimmedEmail = email.trim();
    allowed = allowed.filter(e => e.email.toLowerCase() !== trimmedEmail.toLowerCase());
    saveAllowedEmails(allowed);
    res.json({ success: true, allowed });
});

// Dashboard: Export Allowed Emails to JSON
app.get('/api/export-allowed-emails-json', (req, res) => {
    const allowed = loadAllowedEmails();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="allowed_emails.json"');
    res.send(JSON.stringify(allowed, null, 2));
});

// Dashboard: Import JSON (merge with target data)
app.post('/api/import-json', (req, res) => {
    const { target } = req.query; // 'installations' or 'allowed_emails'
    const data = req.body;
    
    if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'Data must be a JSON array' });
    }
    
    if (target === 'installations') {
        let existing = loadInstallations();
        data.forEach(newItem => {
            if (!newItem.email) return;
            const idx = existing.findIndex(e => (e.email || '').toLowerCase() === newItem.email.toLowerCase() && (e.pcName || '').toLowerCase() === (newItem.pcName || '').toLowerCase());
            if (idx !== -1) {
                existing[idx] = { ...existing[idx], ...newItem };
            } else {
                existing.push(newItem);
            }
        });
        saveInstallations(existing);
    } else if (target === 'allowed_emails') {
        let existing = loadAllowedEmails();
        data.forEach(newItem => {
            if (!newItem.email) return;
            const idx = existing.findIndex(e => (e.email || '').toLowerCase() === newItem.email.toLowerCase());
            if (idx !== -1) {
                existing[idx] = { ...existing[idx], ...newItem };
            } else {
                existing.push(newItem);
            }
        });
        saveAllowedEmails(existing);
    } else {
        return res.status(400).json({ error: 'Invalid target' });
    }
    
    res.json({ success: true, count: data.length });
});

// Dashboard: get all installations
app.get('/api/installations', (req, res) => {
    res.json(loadInstallations());
});

app.get('/api/installations-export', (req, res) => {
    const data = loadInstallations();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=installations.json');
    res.send(JSON.stringify(data, null, 2));
});

// Dashboard: trigger uninstallation for a PC
app.post('/api/uninstall-trigger', (req, res) => {
    const { email, pcName } = req.body;
    let installations = loadInstallations();
    const item = installations.find(i => i.email === email && i.pcName === pcName);
    if (item) {
        item.status = 'Pending Uninstall';
        saveInstallations(installations);
        return res.json({ success: true, message: 'Uninstallation command queued' });
    }
    res.status(404).json({ error: 'Installation not found' });
});

// Dashboard: update client status (start/stop)
app.post('/api/client-status', (req, res) => {
    const { email, pcName, action } = req.body;
    let installations = loadInstallations();
    const item = installations.find(i => i.email === email && i.pcName === pcName);
    if (item) {
        if (action === 'stop') {
            item.status = 'Stopped';
        } else if (action === 'start') {
            item.status = 'Active';
        }
        saveInstallations(installations);
        return res.json({ success: true });
    }
    res.status(404).json({ error: 'Installation not found' });
});

// Dashboard: Get global service state
app.get('/api/global-status', (req, res) => {
    res.json(loadGlobalStatus());
});

// Dashboard: Set global service state
app.post('/api/global-status', (req, res) => {
    const { state } = req.body;
    if (state === 'Running' || state === 'Stopped') {
        saveGlobalStatus({ state });
        return res.json({ success: true, state });
    }
    res.status(400).json({ error: 'Invalid state' });
});

// Dashboard: get discovered peers on network
app.get('/api/peers', (req, res) => {
    // Filter out expired peers (older than 15s)
    const now = Date.now();
    const activePeers = Object.values(discoveredPeers).filter(p => now - p.lastSeen < 15000);
    res.json(activePeers);
});

// Get local network interfaces
function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}

// UDP Peer Discovery Setup
const udpSocket = dgram.createSocket('udp4');

udpSocket.on('error', (err) => {
    console.error('UDP Discovery Socket error (UDP Discovery disabled):', err.message);
    try {
        udpSocket.close();
    } catch(e) {}
});

udpSocket.on('message', (msg, rinfo) => {
    try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'PING') {
            const reply = {
                type: 'PONG',
                hostname: os.hostname(),
                ips: getLocalIPs(),
                port: PORT
            };
            const buffer = Buffer.from(JSON.stringify(reply));
            udpSocket.send(buffer, 0, buffer.length, rinfo.port, rinfo.address);
        } else if (data.type === 'PONG') {
            const key = `${rinfo.address}:${data.port}`;
            // Avoid adding ourselves
            const localIPs = getLocalIPs();
            if (!localIPs.includes(rinfo.address) && rinfo.address !== '127.0.0.1') {
                discoveredPeers[key] = {
                    hostname: data.hostname,
                    ipAddress: rinfo.address,
                    port: data.port,
                    lastSeen: Date.now()
                };
            }
        }
    } catch (e) {
        // Ignore parse errors
    }
});

udpSocket.on('listening', () => {
    try {
        const address = udpSocket.address();
        console.log(`UDP Discovery Server listening on ${address.address}:${address.port}`);
        
        // Periodically broadcast PING to discover peers
        setInterval(() => {
            try {
                const ping = Buffer.from(JSON.stringify({ type: 'PING' }));
                udpSocket.setBroadcast(true);
                // Broadcast on local subnet
                udpSocket.send(ping, 0, ping.length, UDP_PORT, '255.255.255.255', (err) => {
                    if (err) console.error('UDP Broadcast error:', err);
                });
            } catch (ex) {
                console.error('UDP Broadcast send exception:', ex.message);
            }
        }, 5000);
    } catch (e) {
        console.error('UDP listening hook error:', e.message);
    }
});

try {
    udpSocket.bind(UDP_PORT);
} catch (err) {
    console.error('Failed to bind UDP socket (UDP Discovery disabled):', err.message);
}

app.listen(PORT, () => {
    console.log(`Web Dashboard Backend listening at http://localhost:${PORT}`);
});
