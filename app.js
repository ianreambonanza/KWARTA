(() => {
  'use strict';

  /* ---------- Helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
  const fmt = n => money.format(n || 0);
  const pad = n => String(n).padStart(2, '0');
  const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => isoDate(new Date());
  const monthKey = d => d.slice(0, 7);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = s => parseDate(s).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtDay = s => parseDate(s).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
  const monthLabel = k => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }); };
  const shiftMonth = (k, n) => { const [y, m] = k.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const daysInMonth = (y, m) => new Date(y, m, 0).getDate(); // m is 1-based
  const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
  const addMonths = (s, n) => {
    const d = parseDate(s);
    const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
    t.setDate(Math.min(d.getDate(), daysInMonth(t.getFullYear(), t.getMonth() + 1)));
    return isoDate(t);
  };

  const EXPENSE_CATS = ['Food', 'Transport', 'Bills', 'Shopping', 'Health', 'Entertainment', 'Savings', 'Other'];
  const INCOME_CATS = ['Salary', 'Business', 'Gift', 'Other'];
  const ACCOUNT_TYPES = ['Bank', 'E-wallet', 'Cash', 'Credit / Other'];
  const AVATARS = ['😀', '🧑', '👩', '👨', '🐱', '🐶', '🦊', '🌟', '💼', '🎓'];

  /* ---------- Storage ---------- */
  // IndexedDB-backed key/value store. Everything is loaded into memory at
  // startup (init), reads are synchronous, writes go through to IndexedDB.
  // Falls back to localStorage if IndexedDB is unavailable.
  const store = (() => {
    const DB_NAME = 'kwarta', STORE = 'kv', PREFIX = 'kwarta:';
    const cache = new Map();
    let db = null;

    const openDb = () => new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const write = (fn) => {
      if (!db) return;
      try {
        const t = db.transaction(STORE, 'readwrite');
        fn(t.objectStore(STORE));
        t.onerror = () => toast('Could not save. Storage may be full or blocked.');
      } catch { toast('Could not save. Storage may be full or blocked.'); }
    };

    const loadAll = () => new Promise(resolve => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { cache.set(c.key, c.value); c.continue(); } };
      t.oncomplete = resolve;
      t.onerror = resolve;
      t.onabort = resolve;
    });

    return {
      async init() {
        try {
          if (!('indexedDB' in window)) throw new Error('no idb');
          db = await openDb();
          await loadAll();
        } catch { db = null; }

        // Import data saved by the earlier localStorage version (kept as a backup, not deleted).
        try {
          if (!cache.has(PREFIX + 'profiles')) {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && k.startsWith(PREFIX)) {
                const v = JSON.parse(localStorage.getItem(k));
                cache.set(k, v);
                write(s => s.put(v, k));
              }
            }
          }
        } catch { /* ignore */ }

        // Ask the browser not to evict our data under storage pressure.
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
      },
      get(k, fallback) {
        return cache.has(k) ? JSON.parse(JSON.stringify(cache.get(k))) : fallback;
      },
      set(k, v) {
        const copy = JSON.parse(JSON.stringify(v));
        cache.set(k, copy);
        if (db) write(s => s.put(copy, k));
        else { try { localStorage.setItem(k, JSON.stringify(copy)); } catch { toast('Could not save. Storage may be full or blocked.'); } }
      },
      remove(k) {
        cache.delete(k);
        if (db) write(s => s.delete(k));
        else { try { localStorage.removeItem(k); } catch { /* ignore */ } }
      }
    };
  })();

  let profiles = [];
  let activeId = null;
  let data = null;
  let view = 'home';
  let month = monthKey(today());
  let txFilter = 'all';

  const emptyData = () => ({ accounts: [], transactions: [], goals: [], payables: [], salary: null });
  const loadData = () => { data = Object.assign(emptyData(), store.get('kwarta:data:' + activeId, {})); };
  const save = () => store.set('kwarta:data:' + activeId, data);
  const saveProfiles = () => { store.set('kwarta:profiles', profiles); store.set('kwarta:active', activeId); };
  const activeProfile = () => profiles.find(p => p.id === activeId);

  /* ---------- Calculations ---------- */
  const accountById = id => data.accounts.find(a => a.id === id);
  const accountName = id => (accountById(id) || { name: 'Deleted account' }).name;

  function balanceOf(a) {
    let b = Number(a.opening) || 0;
    for (const t of data.transactions) {
      if (t.type === 'income' && t.accountId === a.id) b += t.amount;
      else if (t.type === 'expense' && t.accountId === a.id) b -= t.amount;
      else if (t.type === 'transfer') {
        if (t.accountId === a.id) b -= t.amount;
        if (t.toAccountId === a.id) b += t.amount;
      }
    }
    return b;
  }
  const totalBalance = () => data.accounts.reduce((s, a) => s + balanceOf(a), 0);

  function monthStats(k) {
    let inflow = 0, outflow = 0;
    for (const t of data.transactions) {
      if (monthKey(t.date) !== k) continue;
      if (t.type === 'income') inflow += t.amount;
      else if (t.type === 'expense') outflow += t.amount;
    }
    return { inflow, outflow, net: inflow - outflow };
  }

  const sortedTxns = list => [...list].sort((a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0));

  function nextPayday(s) {
    const days = [s.day1];
    if (s.frequency === 'semi' && s.day2) days.push(s.day2);
    const now = new Date(), t = today();
    for (let i = 0; i < 3; i++) {
      const y = now.getFullYear(), m = now.getMonth() + i;
      const base = new Date(y, m, 1);
      const dim = daysInMonth(base.getFullYear(), base.getMonth() + 1);
      const cands = days.map(d => isoDate(new Date(base.getFullYear(), base.getMonth(), Math.min(d, dim)))).sort();
      const found = cands.find(c => c >= t);
      if (found) return found;
    }
    return null;
  }

  /* ---------- UI primitives ---------- */
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  let modalPersistent = false;
  function openSheet(title, html, opts = {}) {
    modalPersistent = !!opts.persistent;
    const m = $('#modal');
    m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h2>${esc(title)}</h2>${modalPersistent ? '' : '<button class="icon-btn" data-close aria-label="Close">✕</button>'}</div>
      ${html}</div>`;
    m.hidden = false;
    document.body.classList.add('noscroll');
    return $('.sheet', m);
  }
  function closeModal() {
    const m = $('#modal');
    m.hidden = true; m.innerHTML = '';
    document.body.classList.remove('noscroll');
  }

  function fieldHTML(f) {
    const id = 'f_' + f.name;
    const req = f.required ? 'required' : '';
    if (f.type === 'checkbox') {
      return `<label class="check"><input type="checkbox" id="${id}" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
    }
    let input;
    if (f.type === 'select') {
      input = `<select id="${id}" name="${f.name}" ${req}>${f.options.map(o =>
        `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    } else {
      const num = f.type === 'number';
      input = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}"
        ${num ? 'inputmode="decimal" step="' + (f.step || '0.01') + '"' : ''} ${f.min != null ? 'min="' + f.min + '"' : ''}
        ${f.max != null ? 'max="' + f.max + '"' : ''} ${f.list ? 'list="dl_' + f.name + '"' : ''}
        ${f.placeholder ? 'placeholder="' + esc(f.placeholder) + '"' : ''} ${f.maxlength ? 'maxlength="' + f.maxlength + '"' : ''} ${req}>` +
        (f.list ? `<datalist id="dl_${f.name}">${f.list.map(o => `<option value="${esc(o)}">`).join('')}</datalist>` : '');
    }
    return `<div class="field" data-field="${f.name}"><label for="${id}">${esc(f.label)}</label>${input}</div>`;
  }

  function openForm(cfg) {
    const html = `<form id="kform" autocomplete="off" novalidate>
      ${cfg.intro ? `<p class="muted" style="margin-top:0">${esc(cfg.intro)}</p>` : ''}
      ${cfg.fields.map(fieldHTML).join('')}
      <div class="form-actions">
        ${cfg.onDelete ? '<button type="button" class="btn danger" data-del>Delete</button>' : ''}
        <button type="submit" class="btn primary">${esc(cfg.submit || 'Save')}</button>
      </div></form>`;
    const sheet = openSheet(cfg.title, html, { persistent: cfg.persistent });
    const form = $('#kform', sheet);

    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const v = {};
      for (const f of cfg.fields) {
        const el = form.elements[f.name];
        if (!el) continue;
        if (f.type === 'checkbox') v[f.name] = el.checked;
        else if (f.type === 'number') v[f.name] = el.value === '' ? null : parseFloat(el.value);
        else v[f.name] = el.value.trim();
      }
      if (cfg.onSubmit(v) !== false) closeModal();
    });
    const del = $('[data-del]', form);
    if (del) del.addEventListener('click', () => { if (cfg.onDelete()) closeModal(); });
    if (cfg.onOpen) cfg.onOpen(form);
    const first = form.querySelector('input:not([type=checkbox]), select');
    if (first && !cfg.noFocus) setTimeout(() => first.focus({ preventScroll: true }), 50);
  }

  const toggleField = (form, name, show) => {
    const w = $(`[data-field="${name}"]`, form);
    if (w) w.hidden = !show;
  };
  const accountOptions = () => data.accounts.map(a => ({ value: a.id, label: a.name }));

  function needAccount() {
    if (data.accounts.length) return false;
    toast('Add an account first');
    view = 'accounts'; render(); editAccount();
    return true;
  }

  /* ---------- Forms: Transactions ---------- */
  function editTxn(id, preset = {}) {
    if (needAccount()) return;
    const t = id ? data.transactions.find(x => x.id === id) : null;
    const base = t || { type: 'expense', amount: '', accountId: data.accounts[0].id, toAccountId: (data.accounts[1] || data.accounts[0]).id, category: '', date: today(), note: '', ...preset };
    openForm({
      title: t ? 'Edit transaction' : 'New transaction',
      fields: [
        { name: 'type', label: 'Type', type: 'select', value: base.type, options: [{ value: 'expense', label: 'Expense (money out)' }, { value: 'income', label: 'Income (money in)' }, { value: 'transfer', label: 'Transfer between accounts' }] },
        { name: 'amount', label: 'Amount (₱)', type: 'number', value: base.amount, min: 0.01, required: true, placeholder: '0.00' },
        { name: 'accountId', label: base.type === 'transfer' ? 'From account' : 'Account', type: 'select', value: base.accountId, options: accountOptions() },
        { name: 'toAccountId', label: 'To account', type: 'select', value: base.toAccountId, options: accountOptions() },
        { name: 'category', label: 'Category', value: base.category, list: [...new Set([...EXPENSE_CATS, ...INCOME_CATS])], placeholder: 'e.g. Food' },
        { name: 'date', label: 'Date', type: 'date', value: base.date, required: true },
        { name: 'note', label: 'Note (optional)', value: base.note, maxlength: 80 }
      ],
      onOpen(form) {
        const typeEl = form.elements.type;
        const sync = () => {
          const tr = typeEl.value === 'transfer';
          toggleField(form, 'toAccountId', tr);
          toggleField(form, 'category', !tr);
          $('label[for="f_accountId"]', form).textContent = tr ? 'From account' : 'Account';
        };
        typeEl.addEventListener('change', sync); sync();
      },
      onSubmit(v) {
        if (v.type === 'transfer' && v.accountId === v.toAccountId) { toast('Pick two different accounts'); return false; }
        const rec = {
          id: t ? t.id : uid(), created: t ? t.created : Date.now(),
          type: v.type, amount: v.amount, accountId: v.accountId,
          toAccountId: v.type === 'transfer' ? v.toAccountId : null,
          category: v.type === 'transfer' ? 'Transfer' : (v.category || 'Other'),
          date: v.date, note: v.note
        };
        if (t) data.transactions[data.transactions.indexOf(t)] = rec; else data.transactions.push(rec);
        save(); render(); toast(t ? 'Transaction updated' : 'Transaction added');
      },
      onDelete: t ? () => {
        if (!confirm('Delete this transaction?')) return false;
        data.transactions = data.transactions.filter(x => x.id !== t.id);
        save(); render(); toast('Deleted'); return true;
      } : null
    });
  }

  /* ---------- Forms: Accounts ---------- */
  function editAccount(id) {
    const a = id ? accountById(id) : null;
    openForm({
      title: a ? 'Edit account' : 'New account',
      fields: [
        { name: 'name', label: 'Account name', value: a ? a.name : '', required: true, placeholder: 'e.g. BDO Savings', maxlength: 30 },
        { name: 'type', label: 'Type', type: 'select', value: a ? a.type : 'Bank', options: ACCOUNT_TYPES.map(x => ({ value: x, label: x })) },
        { name: 'opening', label: 'Starting balance (₱)', type: 'number', value: a ? a.opening : 0, required: true }
      ],
      onSubmit(v) {
        if (a) { a.name = v.name; a.type = v.type; a.opening = v.opening; }
        else data.accounts.push({ id: uid(), name: v.name, type: v.type, opening: v.opening });
        save(); render(); toast(a ? 'Account updated' : 'Account added');
      },
      onDelete: a ? () => {
        const n = data.transactions.filter(t => t.accountId === a.id || t.toAccountId === a.id).length;
        if (!confirm(n ? `Delete "${a.name}" and its ${n} transaction(s)?` : `Delete "${a.name}"?`)) return false;
        data.transactions = data.transactions.filter(t => t.accountId !== a.id && t.toAccountId !== a.id);
        data.accounts = data.accounts.filter(x => x.id !== a.id);
        if (data.salary && data.salary.accountId === a.id) data.salary.accountId = (data.accounts[0] || {}).id || null;
        save(); render(); toast('Account deleted'); return true;
      } : null
    });
  }

  /* ---------- Forms: Goals ---------- */
  function editGoal(id) {
    const g = id ? data.goals.find(x => x.id === id) : null;
    openForm({
      title: g ? 'Edit goal' : 'New savings goal',
      fields: [
        { name: 'name', label: 'Goal name', value: g ? g.name : '', required: true, placeholder: 'e.g. Emergency fund', maxlength: 40 },
        { name: 'target', label: 'Target amount (₱)', type: 'number', value: g ? g.target : '', min: 1, required: true },
        { name: 'saved', label: 'Saved so far (₱)', type: 'number', value: g ? g.saved : 0, min: 0, required: true },
        { name: 'deadline', label: 'Target date (optional)', type: 'date', value: g ? g.deadline : '' }
      ],
      onSubmit(v) {
        if (g) Object.assign(g, { name: v.name, target: v.target, saved: v.saved, deadline: v.deadline });
        else data.goals.push({ id: uid(), name: v.name, target: v.target, saved: v.saved, deadline: v.deadline });
        save(); render(); toast(g ? 'Goal updated' : 'Goal added');
      },
      onDelete: g ? () => {
        if (!confirm(`Delete goal "${g.name}"?`)) return false;
        data.goals = data.goals.filter(x => x.id !== g.id);
        save(); render(); return true;
      } : null
    });
  }

  function contribute(id) {
    const g = data.goals.find(x => x.id === id);
    if (!g) return;
    const opts = [{ value: '', label: "Don't deduct from an account" }, ...accountOptions()];
    openForm({
      title: 'Add to ' + g.name,
      submit: 'Add savings',
      fields: [
        { name: 'amount', label: 'Amount (₱)', type: 'number', value: '', min: 0.01, required: true },
        { name: 'accountId', label: 'Take it from', type: 'select', value: data.accounts.length ? data.accounts[0].id : '', options: opts },
        { name: 'date', label: 'Date', type: 'date', value: today(), required: true }
      ],
      onSubmit(v) {
        g.saved += v.amount;
        if (v.accountId) {
          data.transactions.push({ id: uid(), created: Date.now(), type: 'expense', amount: v.amount, accountId: v.accountId, toAccountId: null, category: 'Savings', date: v.date, note: 'Goal: ' + g.name });
        }
        save(); render(); toast('Savings added');
      }
    });
  }

  /* ---------- Forms: Payables ---------- */
  function editBill(id) {
    const b = id ? data.payables.find(x => x.id === id) : null;
    const d = new Date(); d.setDate(d.getDate() + 7);
    openForm({
      title: b ? 'Edit bill' : 'New bill',
      fields: [
        { name: 'name', label: 'Bill name', value: b ? b.name : '', required: true, placeholder: 'e.g. Electricity', maxlength: 40 },
        { name: 'amount', label: 'Amount (₱)', type: 'number', value: b ? b.amount : '', min: 0.01, required: true },
        { name: 'due', label: 'Due date', type: 'date', value: b ? b.due : isoDate(d), required: true },
        { name: 'recurring', label: 'Repeats every month', type: 'checkbox', value: b ? b.recurring : false }
      ],
      onSubmit(v) {
        if (b) Object.assign(b, { name: v.name, amount: v.amount, due: v.due, recurring: v.recurring });
        else data.payables.push({ id: uid(), name: v.name, amount: v.amount, due: v.due, recurring: v.recurring, paid: false });
        save(); render(); toast(b ? 'Bill updated' : 'Bill added');
      },
      onDelete: b ? () => {
        if (!confirm(`Delete "${b.name}"?`)) return false;
        data.payables = data.payables.filter(x => x.id !== b.id);
        save(); render(); return true;
      } : null
    });
  }

  function payBill(id) {
    const b = data.payables.find(x => x.id === id);
    if (!b || needAccount()) return;
    openForm({
      title: 'Pay ' + b.name,
      submit: 'Mark as paid',
      fields: [
        { name: 'amount', label: 'Amount paid (₱)', type: 'number', value: b.amount, min: 0.01, required: true },
        { name: 'accountId', label: 'Paid from', type: 'select', value: data.accounts[0].id, options: accountOptions() },
        { name: 'date', label: 'Date paid', type: 'date', value: today(), required: true }
      ],
      onSubmit(v) {
        data.transactions.push({ id: uid(), created: Date.now(), type: 'expense', amount: v.amount, accountId: v.accountId, toAccountId: null, category: 'Bills', date: v.date, note: b.name });
        b.lastPaid = v.date;
        if (b.recurring) b.due = addMonths(b.due, 1);
        else { b.paid = true; b.paidOn = v.date; }
        save(); render(); toast('Bill paid');
      }
    });
  }

  /* ---------- Forms: Salary ---------- */
  function editSalary() {
    if (needAccount()) return;
    const s = data.salary || { amount: '', frequency: 'monthly', day1: 15, day2: 30, accountId: data.accounts[0].id };
    openForm({
      title: data.salary ? 'Edit salary' : 'Set up salary',
      fields: [
        { name: 'amount', label: 'Amount per payout (₱)', type: 'number', value: s.amount, min: 0.01, required: true },
        { name: 'frequency', label: 'How often', type: 'select', value: s.frequency, options: [{ value: 'monthly', label: 'Once a month' }, { value: 'semi', label: 'Twice a month' }] },
        { name: 'day1', label: 'Payday (day of month)', type: 'number', step: '1', min: 1, max: 31, value: s.day1, required: true },
        { name: 'day2', label: 'Second payday (day of month)', type: 'number', step: '1', min: 1, max: 31, value: s.day2 },
        { name: 'accountId', label: 'Deposited to', type: 'select', value: s.accountId, options: accountOptions() }
      ],
      onOpen(form) {
        const sync = () => toggleField(form, 'day2', form.elements.frequency.value === 'semi');
        form.elements.frequency.addEventListener('change', sync); sync();
      },
      onSubmit(v) {
        data.salary = Object.assign(data.salary || {}, {
          amount: v.amount, frequency: v.frequency, day1: Math.round(v.day1),
          day2: v.frequency === 'semi' ? Math.round(v.day2 || 30) : null, accountId: v.accountId
        });
        save(); render(); toast('Salary saved');
      },
      onDelete: data.salary ? () => {
        if (!confirm('Remove salary setup? Past salary transactions stay.')) return false;
        data.salary = null; save(); render(); return true;
      } : null
    });
  }

  function recordSalary() {
    const s = data.salary;
    if (!s) return;
    openForm({
      title: 'Record salary received',
      submit: 'Add income',
      fields: [
        { name: 'amount', label: 'Amount received (₱)', type: 'number', value: s.amount, min: 0.01, required: true },
        { name: 'accountId', label: 'Deposited to', type: 'select', value: accountById(s.accountId) ? s.accountId : data.accounts[0].id, options: accountOptions() },
        { name: 'date', label: 'Date', type: 'date', value: today(), required: true }
      ],
      onSubmit(v) {
        data.transactions.push({ id: uid(), created: Date.now(), type: 'income', amount: v.amount, accountId: v.accountId, toAccountId: null, category: 'Salary', date: v.date, note: 'Salary' });
        s.lastReceived = v.date;
        save(); render(); toast('Salary recorded');
      }
    });
  }

  /* ---------- Profiles ---------- */
  function profileForm(id, firstRun = false) {
    const p = id ? profiles.find(x => x.id === id) : null;
    openForm({
      title: firstRun ? 'Welcome to KWARTA' : (p ? 'Edit profile' : 'New profile'),
      intro: firstRun ? 'Create your profile to get started. Each profile keeps its own accounts, goals and bills.' : '',
      persistent: firstRun,
      submit: firstRun ? 'Get started' : 'Save',
      fields: [
        { name: 'name', label: 'Your name', value: p ? p.name : '', required: true, maxlength: 20, placeholder: 'e.g. Juan' },
        { name: 'emoji', label: 'Avatar', type: 'select', value: p ? p.emoji : AVATARS[0], options: AVATARS.map(a => ({ value: a, label: a })) }
      ],
      onSubmit(v) {
        if (p) { p.name = v.name; p.emoji = v.emoji; }
        else {
          const np = { id: uid(), name: v.name, emoji: v.emoji };
          profiles.push(np); activeId = np.id; loadData();
          view = 'home'; month = monthKey(today());
        }
        saveProfiles(); render();
        if (!p) toast('Hi, ' + v.name + '!');
      },
      onDelete: p && profiles.length > 1 ? () => {
        if (!confirm(`Delete profile "${p.name}" and all its data? This cannot be undone.`)) return false;
        store.remove('kwarta:data:' + p.id);
        profiles = profiles.filter(x => x.id !== p.id);
        if (activeId === p.id) { activeId = profiles[0].id; loadData(); }
        saveProfiles(); render(); return true;
      } : null
    });
  }

  function profilesSheet() {
    const html = `${profiles.map(p => `
      <div class="profile-row">
        <button class="switch" data-pact="switch" data-id="${p.id}">
          <span class="avatar">${p.emoji}</span>
          <span>${esc(p.name)}${p.id === activeId ? ' <span class="badge green">Active</span>' : ''}</span>
        </button>
        <button class="btn sm" data-pact="edit" data-id="${p.id}">Edit</button>
      </div>`).join('')}
      <div class="btn-row">
        <button class="btn primary" style="flex:1" data-pact="add">+ Add profile</button>
        <button class="btn" data-pact="export">Export backup</button>
      </div>
      ${installEvent ? '<button class="btn block" style="margin-top:10px" data-pact="install">📲 Install KWARTA on this device</button>' : ''}`;
    const sheet = openSheet('Profiles', html);
    sheet.addEventListener('click', e => {
      const b = e.target.closest('[data-pact]');
      if (!b) return;
      const act = b.dataset.pact, id = b.dataset.id;
      if (act === 'switch') {
        activeId = id; saveProfiles(); loadData(); month = monthKey(today()); view = 'home';
        closeModal(); render(); toast('Switched to ' + activeProfile().name);
      } else if (act === 'edit') { closeModal(); profileForm(id); }
      else if (act === 'add') { closeModal(); profileForm(); }
      else if (act === 'export') exportData();
      else if (act === 'install' && installEvent) {
        closeModal();
        installEvent.prompt();
        installEvent.userChoice.finally(() => { installEvent = null; });
      }
    });
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ profile: activeProfile(), data }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kwarta-${activeProfile().name.toLowerCase().replace(/\W+/g, '-')}-${today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- Views ---------- */
  const monthNav = () => `<div class="month-nav">
    <button data-act="prev-month" aria-label="Previous month">‹</button>
    <strong>${monthLabel(month)}</strong>
    <button data-act="next-month" aria-label="Next month">›</button></div>`;

  function txnRow(t) {
    const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
    const icon = t.type === 'income' ? '↓' : t.type === 'expense' ? '↑' : '⇄';
    const where = t.type === 'transfer' ? `${esc(accountName(t.accountId))} → ${esc(accountName(t.toAccountId))}` : esc(accountName(t.accountId));
    const sub = `${t.type === 'transfer' ? '' : esc(t.category) + ' · '}${where}${t.note ? ' · ' + esc(t.note) : ''}`;
    return `<button class="row" data-act="edit-txn" data-id="${t.id}">
      <div class="dot ${t.type}">${icon}</div>
      <div class="grow"><div class="title">${esc(t.note || t.category)}</div><div class="sub">${sub}</div></div>
      <div class="amt ${t.type === 'income' ? 'pos' : t.type === 'expense' ? 'neg' : ''}">${sign}${fmt(t.amount)}</div></button>`;
  }

  function billRow(b) {
    const diff = daysBetween(today(), b.due);
    let badge;
    if (diff < 0) badge = `<span class="badge red">Overdue ${-diff}d</span>`;
    else if (diff === 0) badge = '<span class="badge amber">Due today</span>';
    else if (diff <= 7) badge = `<span class="badge amber">Due in ${diff}d</span>`;
    else badge = `<span class="badge gray">${fmtDate(b.due)}</span>`;
    return `<div class="row">
      <button class="grow" style="text-align:left" data-act="edit-bill" data-id="${b.id}">
        <div class="title">${esc(b.name)}${b.recurring ? ' 🔁' : ''}</div><div class="sub">${badge}</div></button>
      <div class="amt">${fmt(b.amount)}</div>
      <button class="btn sm primary" data-act="pay-bill" data-id="${b.id}">Pay</button></div>`;
  }

  function goalCard(g, full) {
    const pct = g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
    const done = g.saved >= g.target;
    let hint = '';
    if (done) hint = '🎉 Goal reached!';
    else if (g.deadline) {
      const left = daysBetween(today(), g.deadline);
      if (left < 0) hint = 'Past target date';
      else {
        const months = Math.max(1, Math.ceil(left / 30.4));
        hint = `${fmt((g.target - g.saved) / months)}/month to hit it by ${fmtDate(g.deadline)}`;
      }
    }
    return `<div class="${full ? 'card' : ''}" ${full ? '' : 'style="padding:8px 0"'}>
      <div class="card-head" style="margin-bottom:0"><strong>${esc(g.name)}</strong><span class="muted small">${Math.round(pct)}%</span></div>
      <div class="progress ${done ? 'done' : ''}"><div style="width:${pct}%"></div></div>
      <div class="small"><strong>${fmt(g.saved)}</strong> <span class="muted">of ${fmt(g.target)}</span></div>
      ${full ? `<div class="small muted" style="margin-top:2px">${hint}</div>
      <div class="btn-row"><button class="btn sm primary" data-act="contribute" data-id="${g.id}">+ Add savings</button>
      <button class="btn sm" data-act="edit-goal" data-id="${g.id}">Edit</button></div>` : ''}</div>`;
  }

  function homeView() {
    if (!data.accounts.length) {
      return `<div class="card empty"><div class="big-ico">🏦</div><strong>Let's set up your money</strong>
        <p>Add your first bank account or wallet to start tracking.</p>
        <button class="btn primary" data-act="add-account">+ Add account</button></div>`;
    }
    const st = monthStats(month);
    const [y, m] = month.split('-').map(Number);
    const n = daysInMonth(y, m);
    const perDay = Array(n).fill(0);
    let todaySpend = 0;
    const t0 = today();
    for (const t of data.transactions) {
      if (t.type !== 'expense') continue;
      if (monthKey(t.date) === month) perDay[Number(t.date.slice(8, 10)) - 1] += t.amount;
      if (t.date === t0) todaySpend += t.amount;
    }
    const max = Math.max(...perDay, 1);
    const avg = st.outflow / (month === monthKey(t0) ? Number(t0.slice(8, 10)) : n);
    const bars = perDay.map((v, i) => {
      const ds = `${month}-${pad(i + 1)}`;
      const label = (i === 0 || (i + 1) % 5 === 0) ? i + 1 : '';
      return `<div class="bar-col" title="${fmtDate(ds)}: ${fmt(v)}"><div class="bar-track"><div class="bar ${v ? '' : 'zero'} ${ds === t0 ? 'today' : ''}" style="height:${v ? Math.max(4, v / max * 100) : 2}%"></div></div><span>${label}</span></div>`;
    }).join('');

    const unpaid = data.payables.filter(b => !b.paid).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 3);
    const goals = data.goals.slice(0, 2);
    const recent = sortedTxns(data.transactions).slice(0, 5);

    return `${monthNav()}
      <div class="hero"><div class="label">Total balance</div><div class="big">${fmt(totalBalance())}</div>
        <div class="label" style="margin-top:6px">${data.accounts.length} account${data.accounts.length > 1 ? 's' : ''}</div></div>
      <div class="grid2">
        <div class="stat"><div class="label">Money in</div><div class="val pos">${fmt(st.inflow)}</div></div>
        <div class="stat"><div class="label">Money out</div><div class="val neg">${fmt(st.outflow)}</div></div>
        <div class="stat"><div class="label">Spent today</div><div class="val">${fmt(todaySpend)}</div></div>
        <div class="stat"><div class="label">Net this month</div><div class="val ${st.net >= 0 ? 'pos' : 'neg'}">${st.net >= 0 ? '+' : '−'}${fmt(Math.abs(st.net))}</div></div>
      </div>
      <div class="card"><div class="card-head"><h3>Daily spending</h3><span class="muted small">avg ${fmt(avg)}/day</span></div>
        <div class="bars">${bars}</div></div>
      <div class="card"><div class="card-head"><h3>Accounts</h3><button class="link" data-act="goto" data-v="accounts">See all</button></div>
        ${data.accounts.map(a => `<div class="row"><div class="dot acct">🏦</div><div class="grow"><div class="title">${esc(a.name)}</div><div class="sub">${esc(a.type)}</div></div><div class="amt">${fmt(balanceOf(a))}</div></div>`).join('')}</div>
      ${unpaid.length ? `<div class="card"><div class="card-head"><h3>Upcoming bills</h3><button class="link" data-act="goto" data-v="bills">See all</button></div>${unpaid.map(billRow).join('')}</div>` : ''}
      ${goals.length ? `<div class="card"><div class="card-head"><h3>Savings goals</h3><button class="link" data-act="goto" data-v="goals">See all</button></div>${goals.map(g => goalCard(g, false)).join('')}</div>` : ''}
      <div class="card"><div class="card-head"><h3>Recent activity</h3><button class="link" data-act="goto" data-v="activity">See all</button></div>
        ${recent.length ? recent.map(txnRow).join('') : '<p class="muted" style="margin:0">No transactions yet. Tap + to add one.</p>'}</div>`;
  }

  function activityView() {
    const st = monthStats(month);
    const list = sortedTxns(data.transactions.filter(t => monthKey(t.date) === month && (txFilter === 'all' || t.type === txFilter)));
    const groups = [];
    for (const t of list) {
      let g = groups[groups.length - 1];
      if (!g || g.date !== t.date) { g = { date: t.date, items: [], spent: 0 }; groups.push(g); }
      g.items.push(t);
      if (t.type === 'expense') g.spent += t.amount;
    }
    const chip = (v, label) => `<button class="${txFilter === v ? 'active' : ''}" data-act="filter" data-v="${v}">${label}</button>`;
    return `${monthNav()}
      <div class="grid2">
        <div class="stat"><div class="label">In</div><div class="val pos">${fmt(st.inflow)}</div></div>
        <div class="stat"><div class="label">Out</div><div class="val neg">${fmt(st.outflow)}</div></div>
      </div>
      <div class="filters">${chip('all', 'All')}${chip('expense', 'Expenses')}${chip('income', 'Income')}${chip('transfer', 'Transfers')}</div>
      ${groups.length ? groups.map(g => `<div class="day-head"><span>${g.date === today() ? 'Today' : fmtDay(g.date)}</span><span>${g.spent ? 'Spent ' + fmt(g.spent) : ''}</span></div>
        <div class="card" style="padding:4px 14px">${g.items.map(txnRow).join('')}</div>`).join('')
        : `<div class="card empty"><div class="big-ico">📒</div><p>No transactions for ${monthLabel(month)}.</p><button class="btn primary" data-act="add-txn">+ Add transaction</button></div>`}`;
  }

  function accountsView() {
    if (!data.accounts.length) {
      return `<div class="card empty"><div class="big-ico">🏦</div><strong>No accounts yet</strong><p>Add your banks, e-wallets and cash to see each balance.</p><button class="btn primary" data-act="add-account">+ Add account</button></div>`;
    }
    return `<div class="hero"><div class="label">Total across all accounts</div><div class="big">${fmt(totalBalance())}</div></div>
      <div class="card" style="padding:4px 14px">${data.accounts.map(a => {
        const b = balanceOf(a);
        return `<button class="row" data-act="edit-account" data-id="${a.id}"><div class="dot acct">${a.type === 'Cash' ? '💵' : a.type === 'E-wallet' ? '📱' : '🏦'}</div>
          <div class="grow"><div class="title">${esc(a.name)}</div><div class="sub">${esc(a.type)}</div></div>
          <div class="amt ${b < 0 ? 'neg' : ''}">${fmt(b)}</div></button>`;
      }).join('')}</div>
      <button class="btn block" data-act="add-account">+ Add account</button>`;
  }

  function goalsView() {
    if (!data.goals.length) {
      return `<div class="card empty"><div class="big-ico">🎯</div><strong>No savings goals yet</strong><p>Set a target like an emergency fund or a trip.</p><button class="btn primary" data-act="add-goal">+ New goal</button></div>`;
    }
    const saved = data.goals.reduce((s, g) => s + g.saved, 0);
    const target = data.goals.reduce((s, g) => s + g.target, 0);
    return `<div class="grid2"><div class="stat"><div class="label">Total saved</div><div class="val pos">${fmt(saved)}</div></div>
      <div class="stat"><div class="label">Total target</div><div class="val">${fmt(target)}</div></div></div>
      ${data.goals.map(g => goalCard(g, true)).join('')}`;
  }

  function billsView() {
    const unpaid = data.payables.filter(b => !b.paid).sort((a, b) => a.due.localeCompare(b.due));
    const paid = data.payables.filter(b => b.paid).sort((a, b) => (b.paidOn || '').localeCompare(a.paidOn || ''));
    const totalDue = unpaid.reduce((s, b) => s + b.amount, 0);
    const overdue = unpaid.filter(b => b.due < today()).length;
    if (!data.payables.length) {
      return `<div class="card empty"><div class="big-ico">🧾</div><strong>No bills yet</strong><p>Track rent, utilities, loans and subscriptions.</p><button class="btn primary" data-act="add-bill">+ Add bill</button></div>`;
    }
    return `<div class="grid2"><div class="stat"><div class="label">Total payable</div><div class="val neg">${fmt(totalDue)}</div></div>
      <div class="stat"><div class="label">Overdue</div><div class="val ${overdue ? 'neg' : ''}">${overdue}</div></div></div>
      <div class="card" style="padding:4px 14px"><div style="padding-top:10px"></div>
        ${unpaid.length ? unpaid.map(billRow).join('') : '<p class="muted">All paid. Nice!</p>'}</div>
      ${paid.length ? `<div class="card"><h3>Paid</h3>${paid.slice(0, 8).map(b => `<button class="row" data-act="edit-bill" data-id="${b.id}">
        <div class="grow"><div class="title">${esc(b.name)}</div><div class="sub">Paid ${b.paidOn ? fmtDate(b.paidOn) : ''}</div></div>
        <div class="amt muted">${fmt(b.amount)}</div></button>`).join('')}</div>` : ''}`;
  }

  function salaryView() {
    const s = data.salary;
    if (!s) {
      return `<div class="card empty"><div class="big-ico">💵</div><strong>Set up your salary</strong><p>Save your payday and amount so KWARTA can remind you and log it fast.</p><button class="btn primary" data-act="edit-salary">Set up salary</button></div>`;
    }
    const next = nextPayday(s);
    const away = next ? daysBetween(today(), next) : null;
    const perMonth = s.amount * (s.frequency === 'semi' ? 2 : 1);
    const received = data.transactions.filter(t => t.type === 'income' && t.category === 'Salary' && monthKey(t.date) === monthKey(today())).reduce((a, t) => a + t.amount, 0);
    const history = sortedTxns(data.transactions.filter(t => t.type === 'income' && t.category === 'Salary')).slice(0, 8);
    const sched = s.frequency === 'semi' ? `Every ${ord(s.day1)} and ${ord(s.day2)}` : `Every ${ord(s.day1)} of the month`;
    return `<div class="hero"><div class="label">Next payday</div>
        <div class="big">${next ? fmtDate(next) : '—'}</div>
        <div class="label" style="margin-top:6px">${away === 0 ? 'Today!' : away != null ? 'in ' + away + ' day' + (away > 1 ? 's' : '') : ''} · ${fmt(s.amount)}</div></div>
      <div class="grid2"><div class="stat"><div class="label">Expected per month</div><div class="val">${fmt(perMonth)}</div></div>
        <div class="stat"><div class="label">Received this month</div><div class="val pos">${fmt(received)}</div></div></div>
      <div class="card"><div class="row"><div class="grow"><div class="title">${sched}</div><div class="sub">Deposited to ${esc(accountName(s.accountId))}</div></div>
        <button class="btn sm" data-act="edit-salary">Edit</button></div>
        <button class="btn primary block" style="margin-top:6px" data-act="record-salary">Record salary received</button></div>
      <div class="card"><h3>History</h3>${history.length ? history.map(txnRow).join('') : '<p class="muted" style="margin:0">No salary recorded yet.</p>'}</div>`;
  }

  const ord = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

  const views = { home: homeView, activity: activityView, accounts: accountsView, goals: goalsView, bills: billsView, salary: salaryView };
  const fabLabels = { home: 'Add transaction', activity: 'Add transaction', accounts: 'Add account', goals: 'New goal', bills: 'Add bill' };

  function render() {
    const p = activeProfile();
    if (!p) return;
    $('#profileChip').innerHTML = `<span>${p.emoji}</span><span class="name">${esc(p.name)}</span>`;
    $('#view').innerHTML = views[view]();
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.v === view));
    const fab = $('#fab');
    fab.hidden = !fabLabels[view];
    fab.setAttribute('aria-label', fabLabels[view] || '');
  }

  /* ---------- Events ---------- */
  const actions = {
    'goto': el => { view = el.dataset.v; render(); window.scrollTo(0, 0); },
    'prev-month': () => { month = shiftMonth(month, -1); render(); },
    'next-month': () => { month = shiftMonth(month, 1); render(); },
    'filter': el => { txFilter = el.dataset.v; render(); },
    'fab': () => {
      if (view === 'accounts') editAccount();
      else if (view === 'goals') editGoal();
      else if (view === 'bills') editBill();
      else editTxn();
    },
    'add-txn': () => editTxn(),
    'edit-txn': el => editTxn(el.dataset.id),
    'add-account': () => editAccount(),
    'edit-account': el => editAccount(el.dataset.id),
    'add-goal': () => editGoal(),
    'edit-goal': el => editGoal(el.dataset.id),
    'contribute': el => contribute(el.dataset.id),
    'add-bill': () => editBill(),
    'edit-bill': el => editBill(el.dataset.id),
    'pay-bill': el => payBill(el.dataset.id),
    'edit-salary': () => editSalary(),
    'record-salary': () => recordSalary(),
    'profiles': () => profilesSheet()
  };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
  });

  $('#modal').addEventListener('click', e => {
    if (e.target.closest('[data-close]') || (e.target.id === 'modal' && !modalPersistent)) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#modal').hidden && !modalPersistent) closeModal();
  });

  /* ---------- Boot ---------- */
  // PWA: install prompt + service worker
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; });
  window.addEventListener('appinstalled', () => { installEvent = null; toast('KWARTA installed'); });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ }); });
  }

  store.init().then(() => {
    profiles = store.get('kwarta:profiles', []);
    activeId = store.get('kwarta:active', null);
    if (profiles.length && !activeProfile()) { activeId = profiles[0].id; saveProfiles(); }
    if (activeProfile()) { loadData(); render(); }
    else { $('#profileChip').hidden = true; profileForm(null, true); }
  });
})();
