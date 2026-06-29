document.addEventListener('DOMContentLoaded', () => {
    // API endpoint references
    const API_URL = ''; // Relative paths since hosted on same port

    const clientsTableBody = document.getElementById('clientsTableBody');
    const peersList = document.getElementById('peersList');
    const activeCount = document.getElementById('activeCount');
    const peerCount = document.getElementById('peerCount');
    const btnRefresh = document.getElementById('btnRefresh');
    const toast = document.getElementById('toast');
    
    // Whitelist elements
    const whitelistForm = document.getElementById('whitelistForm');
    const whitelistEmailInput = document.getElementById('whitelistEmailInput');
    const whitelistContainer = document.getElementById('whitelistContainer');
    const whitelistStartDateInput = document.getElementById('whitelistStartDateInput');
    const whitelistEndDateInput = document.getElementById('whitelistEndDateInput');

    // Pre-populate default dates (Start = today, End = today + 30 days)
    function setFormDefaultDates() {
        const today = new Date();
        const nextMonth = new Date(Date.now() + 30*24*60*60*1000);
        whitelistStartDateInput.value = today.toISOString().split('T')[0];
        whitelistEndDateInput.value = nextMonth.toISOString().split('T')[0];
    }
    setFormDefaultDates();

    // Show message toast
    function showToast(message) {
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
        }, 4000);
    }

    // Format ISO string date
    function formatDate(isoString) {
        if (!isoString) return 'Never';
        const date = new Date(isoString);
        return date.toLocaleString();
    }

    // Refresh client list
    async function fetchClients() {
        try {
            const res = await fetch(`${API_URL}/api/installations`);
            if (!res.ok) throw new Error('Failed to fetch clients');
            const data = await res.json();
            
            // Update stats
            const activeClients = data.filter(i => i.status === 'Active' || i.status === 'Pending Uninstall');
            activeCount.textContent = activeClients.length;

            if (data.length === 0) {
                clientsTableBody.innerHTML = `
                    <tr>
                        <td colspan="6" class="loading-state">No registered installations found. Enter your email during Setup to register.</td>
                    </tr>
                `;
                return;
            }

            clientsTableBody.innerHTML = '';
            data.forEach(client => {
                const tr = document.createElement('tr');
                
                let statusClass = 'status-active';
                if (client.status === 'Pending Uninstall') statusClass = 'status-pending';
                if (client.status === 'Uninstalled') statusClass = 'status-uninstalled';

                const isUninstallDisabled = client.status === 'Pending Uninstall' || client.status === 'Uninstalled';

                tr.innerHTML = `
                    <td class="client-name">${escapeHtml(client.pcName)}</td>
                    <td>${escapeHtml(client.email)}</td>
                    <td><code>${escapeHtml(client.ipAddress || 'Unknown')}</code></td>
                    <td>${formatDate(client.lastActive)}</td>
                    <td>
                        <span class="status-badge ${statusClass}">${client.status}</span>
                    </td>
                    <td class="actions-col">
                        <button class="action-btn uninstall-btn" data-email="${client.email}" data-pc="${client.pcName}" ${isUninstallDisabled ? 'disabled' : ''}>
                            <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.5" fill="none"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
                            ${client.status === 'Pending Uninstall' ? 'Pending...' : 'Remote Uninstall'}
                        </button>
                    </td>
                `;
                clientsTableBody.appendChild(tr);
            });

            // Bind click handlers to uninstall buttons
            document.querySelectorAll('.uninstall-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const email = btn.getAttribute('data-email');
                    const pcName = btn.getAttribute('data-pc');
                    
                    if (confirm(`Are you sure you want to trigger a remote uninstallation for ${pcName} (${email})?`)) {
                        await triggerUninstall(email, pcName);
                    }
                });
            });

        } catch (err) {
            console.error(err);
            clientsTableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="loading-state" style="color: var(--danger)">Error connecting to server. Make sure node server is running.</td>
                </tr>
            `;
        }
    }

    // Refresh UDP Discovered Peers
    async function fetchPeers() {
        try {
            const res = await fetch(`${API_URL}/api/peers`);
            if (!res.ok) throw new Error('Failed to fetch peers');
            const peers = await res.json();
            
            peerCount.textContent = peers.length;

            if (peers.length === 0) {
                peersList.innerHTML = '<div class="empty-peers">No other peers discovered on the subnet yet.</div>';
                return;
            }

            peersList.innerHTML = '';
            peers.forEach(peer => {
                const div = document.createElement('div');
                div.className = 'peer-card';
                div.innerHTML = `
                    <div class="peer-info">
                        <span class="peer-host">${escapeHtml(peer.hostname)}</span>
                        <span class="peer-ip">${escapeHtml(peer.ipAddress)}:${peer.port}</span>
                    </div>
                    <span class="peer-status">Active Partner</span>
                `;
                peersList.appendChild(div);
            });
        } catch (err) {
            console.error('Error fetching peers:', err);
        }
    }

    // Trigger Uninstall command
    async function triggerUninstall(email, pcName) {
        try {
            const res = await fetch(`${API_URL}/api/uninstall-trigger`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, pcName })
            });
            const data = await res.json();
            if (data.success) {
                showToast(`Uninstallation request successfully queued for client: ${pcName}`);
                fetchClients();
            } else {
                showToast(`Error: ${data.error || 'Request failed'}`);
            }
        } catch (err) {
            console.error(err);
            showToast('Network error triggering uninstallation');
        }
    }

    // Escape HTML to prevent XSS
    function escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Fetch Allowed Whitelisted Emails
    async function fetchWhitelist() {
        try {
            const res = await fetch(`${API_URL}/api/allowed-emails`);
            if (!res.ok) throw new Error('Failed to fetch whitelist');
            const data = await res.json();
            
            if (data.length === 0) {
                whitelistContainer.innerHTML = '<div class="empty-peers" style="padding: 15px; font-size:12px;">Whitelist is empty. Add emails above to authorize setup.</div>';
                return;
            }

            whitelistContainer.innerHTML = '';
            data.forEach(item => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'whitelist-item';
                
                // Compare expiration
                const today = new Date().toISOString().split('T')[0];
                const isExpired = today > item.endDate;
                const isNotStarted = today < item.startDate;
                
                let dateBadgeClass = '';
                let statusLabel = '';
                if (isExpired) {
                    dateBadgeClass = 'style="color: var(--danger); border-color: rgba(255, 23, 68, 0.2); background: rgba(255, 23, 68, 0.05)"';
                    statusLabel = ' [EXPIRED]';
                } else if (isNotStarted) {
                    dateBadgeClass = 'style="color: var(--warning); border-color: rgba(255, 179, 0, 0.2); background: rgba(255, 179, 0, 0.05)"';
                    statusLabel = ' [PENDING]';
                }

                itemDiv.innerHTML = `
                    <div class="whitelist-item-row">
                        <span class="whitelist-email">${escapeHtml(item.email)}${statusLabel}</span>
                        <button class="remove-whitelist-btn" data-email="${item.email}">Remove</button>
                    </div>
                    <div class="whitelist-item-dates" ${dateBadgeClass}>
                        <span class="whitelist-date-range">Start: ${escapeHtml(item.startDate)}</span>
                        <span class="whitelist-date-range">End: ${escapeHtml(item.endDate)}</span>
                    </div>
                `;
                whitelistContainer.appendChild(itemDiv);
            });

            // Bind remove button handlers
            document.querySelectorAll('.remove-whitelist-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const email = btn.getAttribute('data-email');
                    await removeEmailFromWhitelist(email);
                });
            });

        } catch (err) {
            console.error('Error fetching whitelist:', err);
            whitelistContainer.innerHTML = '<div class="loading-state" style="color:var(--danger)">Error loading whitelist.</div>';
        }
    }

    // Add email to whitelist
    whitelistForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = whitelistEmailInput.value.trim();
        const startDate = whitelistStartDateInput.value;
        const endDate = whitelistEndDateInput.value;
        if (!email) return;

        try {
            const res = await fetch(`${API_URL}/api/allowed-emails`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, startDate, endDate })
            });
            if (res.ok) {
                showToast(`Successfully added ${email} to whitelist.`);
                whitelistEmailInput.value = '';
                setFormDefaultDates();
                fetchWhitelist();
            } else {
                showToast('Failed to add email to whitelist.');
            }
        } catch (err) {
            console.error(err);
            showToast('Network error adding email.');
        }
    });

    // Remove email from whitelist
    async function removeEmailFromWhitelist(email) {
        try {
            const res = await fetch(`${API_URL}/api/allowed-emails`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            if (res.ok) {
                showToast(`Removed ${email} from whitelist.`);
                fetchWhitelist();
            } else {
                showToast('Failed to remove email.');
            }
        } catch (err) {
            console.error(err);
            showToast('Network error removing email.');
        }
    }

    // Initial polls & triggers
    btnRefresh.addEventListener('click', () => {
        fetchClients();
        fetchPeers();
        fetchWhitelist();
        showToast('Refreshing console view...');
    });

    fetchClients();
    fetchPeers();
    fetchWhitelist();

    // Poll every 3 seconds for live updates
    setInterval(fetchClients, 3000);
    setInterval(fetchPeers, 3000);
});
