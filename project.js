// ─────────────────────────────────────────────────────────────────────────────
// Imports — all use the Firebase CDN so no bundler is needed.
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp } from
    "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import {
    getFirestore, collection, doc,
    addDoc, updateDoc, deleteDoc, writeBatch,
    query, where, orderBy, onSnapshot,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js";
import {
    getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Firebase init
// ─────────────────────────────────────────────────────────────────────────────
const firebaseConfig = {
    // This key is PUBLIC but RESTRICTED to SPECIFIC domains in Google Cloud Console.
    apiKey:            "AIzaSyBU9y9wEjM1alYQetDuj4-TgGksrejqRsc",
    authDomain:        "savings-tracker-d2970.firebaseapp.com",
    projectId:         "savings-tracker-d2970",
    storageBucket:     "savings-tracker-d2970.firebasestorage.app",
    messagingSenderId: "300006807151",
    appId:             "1:300006807151:web:14bd11c8d2b25957bd9f9a",
};
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// ─────────────────────────────────────────────────────────────────────────────
// Service Worker
// ─────────────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () =>
        navigator.serviceWorker.register('/service-worker.js')
            .then(r  => console.log('[SW] registered', r.scope))
            .catch(e => console.warn('[SW] failed', e))
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Color palette for categories — accent and matching light background.
const PALETTE = [
    { accent: '#2e7d32', light: '#e8f5e9' }, // green
    { accent: '#1565c0', light: '#e3f2fd' }, // blue
    { accent: '#6a1b9a', light: '#f3e5f5' }, // purple
    { accent: '#e65100', light: '#fff3e0' }, // orange
    { accent: '#ad1457', light: '#fce4ec' }, // pink
    { accent: '#00695c', light: '#e0f2f1' }, // teal
    { accent: '#f9a825', light: '#fffde7' }, // amber
    { accent: '#283593', light: '#e8eaf6' }, // indigo
];

// Seeded on first login when the user has no categories.
const DEFAULT_CATEGORIES = [
    { name: 'Tithing',         allocationPercent: 10, isDefault: false, colorIndex: 5 },
    { name: 'College',         allocationPercent: 20, isDefault: false, colorIndex: 1 },
    { name: 'Germany',         allocationPercent: 20, isDefault: false, colorIndex: 6 },
    { name: 'General Savings', allocationPercent: 30, isDefault: true,  colorIndex: 0 },
    { name: 'Fun',             allocationPercent: 20, isDefault: false,  colorIndex: 4 },
];

// ─────────────────────────────────────────────────────────────────────────────
// App state
//
// categories — Map<id, categoryObject> kept live by onSnapshot.
// transactions — Array of all the user's transactions, sorted newest-first,
//   also kept live. Category balances are derived from this array so they
//   always reflect the current database state without a separate listener.
// ─────────────────────────────────────────────────────────────────────────────
const state = {
    user:         null,
    categories:   new Map(),   // id → { id, name, allocationPercent, isDefault, colorIndex, createdAt }
    transactions: [],          // [ { id, categoryId, categoryName, type, amount, note, timestamp, splitGroupId? } ]
};

let currentView  = 'home';    // 'home' | 'category' | 'manage'
let currentCatId = null;      // active category ID for the detail view
let unsubCats    = null;
let unsubTxns    = null;
let isSeeding    = false;     // guard against double-seeding on first login

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
function escapeHTML(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(String(str ?? '')));
    return d.innerHTML;
}

function fmt(n) {
    // Always show the magnitude; callers add the sign/colour themselves.
    return `$${Math.abs(n).toFixed(2)}`;
}

function fmtDate(ts) {
    if (!ts) return 'Just now';
    return ts.toDate().toLocaleDateString('en-US',
        { month: 'short', day: 'numeric', year: 'numeric' });
}

function palette(colorIndex) {
    return PALETTE[(colorIndex ?? 0) % PALETTE.length];
}

// Convert a hex color to rgba for generating light background tints.
function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// Darken a hex color by multiplying each channel by `factor` (0–1).
// Used so the left-border accent is a noticeably deeper shade than the
// lighter background tint, matching the pre-built palette pairs.
function darkenHex(hex, factor = 0.60) {
    const h = hex.replace('#', '');
    const r = Math.round(parseInt(h.slice(0, 2), 16) * factor);
    const g = Math.round(parseInt(h.slice(2, 4), 16) * factor);
    const b = Math.round(parseInt(h.slice(4, 6), 16) * factor);
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}

// Resolve { accent, light } for a category.
// If a custom hex color is stored on the category:
//   accent = darkened version of the chosen color (used for the left border)
//   light  = low-opacity tint of the chosen color (used for the card background)
// Otherwise falls back to the pre-built PALETTE by colorIndex.
function catColors(cat) {
    if (!cat) return { accent: '#9e9e9e', light: '#f5f5f5' };
    if (cat.color) {
        return {
            accent: darkenHex(cat.color, 0.60),
            light:  hexToRgba(cat.color, 0.15),
        };
    }
    return PALETTE[(cat.colorIndex ?? 0) % PALETTE.length];
}

// Parse a hex value OR a CSS named color (e.g. "teal") into a #rrggbb string.
// Returns null if the input is not a recognisable color.
function parseColorInput(input) {
    if (!input) return null;
    const div = document.createElement('div');
    div.style.color = input;
    document.body.appendChild(div);
    const computed = getComputedStyle(div).color; // "rgb(r, g, b)" or ""
    document.body.removeChild(div);
    const m = computed.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (!m) return null;
    return '#' + [m[1], m[2], m[3]]
        .map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Split calculation
//
// Works entirely in integer cents to avoid floating-point rounding errors.
// Each category's share is floored to the nearest cent, and any remainder
// (1–N cents) is added to whichever category is flagged as the default.
// If the default category has 0% allocation it is inserted as an extra row
// for just the remainder amount.
// ─────────────────────────────────────────────────────────────────────────────
function calculateSplit(totalAmount) {
    const defaultCat   = [...state.categories.values()].find(c => c.isDefault);
    const defaultId    = defaultCat?.id ?? null;
    const totalCents   = Math.round(totalAmount * 100);
    const allocCats    = [...state.categories.values()]
        .filter(c => c.allocationPercent > 0)
        .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));

    let usedCents = 0;
    const splits = [];

    for (const cat of allocCats) {
        const cents = Math.floor(totalCents * cat.allocationPercent / 100);
        usedCents += cents;
        splits.push({
            categoryId:        cat.id,
            categoryName:      cat.name,
            accent:            catColors(cat).accent,
            allocationPercent: cat.allocationPercent,
            isDefault:         cat.id === defaultId,
            amount:            cents / 100,
        });
    }

    const remainderCents = totalCents - usedCents;

    if (remainderCents > 0 && defaultId) {
        const slot = splits.find(s => s.categoryId === defaultId);
        if (slot) {
            slot.amount = (Math.round(slot.amount * 100) + remainderCents) / 100;
            slot.hasRemainder = true;
        } else {
            // Default category has 0% — add it as a remainder-only row.
            const defCat = state.categories.get(defaultId);
            if (defCat) {
                splits.push({
                    categoryId:        defCat.id,
                    categoryName:      defCat.name,
                    accent:            catColors(defCat).accent,
                    allocationPercent: 0,
                    isDefault:         true,
                    hasRemainder:      true,
                    amount:            remainderCents / 100,
                });
            }
        }
    }

    return splits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'success') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className   = `toast ${type}`;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore: categories
// ─────────────────────────────────────────────────────────────────────────────

async function seedDefaultCategories(userId) {
    const batch = writeBatch(db);
    DEFAULT_CATEGORIES.forEach(cat => {
        const ref = doc(collection(db, 'categories'));
        batch.set(ref, { ...cat, userId, createdAt: serverTimestamp() });
    });
    await batch.commit();
    console.log('[App] Default categories seeded');
}

/**
 * Save a new or updated category.
 * If isDefault is being set to true, clears isDefault on all other categories
 * in the same batch so there is always exactly one default.
 */
async function saveCategory(fields, existingId = null) {
    const batch = writeBatch(db);

    if (fields.isDefault) {
        // Remove isDefault from every other category first.
        state.categories.forEach((cat, id) => {
            if (cat.isDefault && id !== existingId) {
                batch.update(doc(db, 'categories', id), { isDefault: false });
            }
        });
    }

    if (existingId) {
        batch.update(doc(db, 'categories', existingId), fields);
    } else {
        const colorIndex = state.categories.size % PALETTE.length;
        const ref = doc(collection(db, 'categories'));
        batch.set(ref, {
            ...fields,
            colorIndex,
            userId:    state.user.uid,
            createdAt: serverTimestamp(),
        });
    }

    await batch.commit();
}

async function deleteCategory(id) {
    await deleteDoc(doc(db, 'categories', id));
}

/**
 * Atomically creates a withdrawal from `fromCat` and a matching deposit to
 * `toCat` for the given `amount`, linking both with a shared `transferGroupId`.
 * Used when deleting a category that still has a positive balance.
 */
async function addTransferTransactions(fromCat, toCat, amount) {
    const transferGroupId = crypto.randomUUID();
    const batch = writeBatch(db);

    const outRef = doc(collection(db, 'transactions'));
    batch.set(outRef, {
        categoryId:      fromCat.id,
        categoryName:    fromCat.name,
        type:            'withdrawal',
        amount,
        note:            `Transferred to ${toCat.name}`,
        transferGroupId,
        userId:          state.user.uid,
        timestamp:       serverTimestamp(),
    });

    const inRef = doc(collection(db, 'transactions'));
    batch.set(inRef, {
        categoryId:      toCat.id,
        categoryName:    toCat.name,
        type:            'deposit',
        amount,
        note:            `Transferred from ${fromCat.name}`,
        transferGroupId,
        userId:          state.user.uid,
        timestamp:       serverTimestamp(),
    });

    await batch.commit();
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore: transactions
// ─────────────────────────────────────────────────────────────────────────────

async function addTransaction(fields) {
    await addDoc(collection(db, 'transactions'), {
        ...fields,
        userId:    state.user.uid,
        timestamp: serverTimestamp(),
    });
}

/** Creates one transaction per split row atomically using a batch write. */
async function addSplitTransactions(splits, label) {
    const splitGroupId = crypto.randomUUID();
    const batch = writeBatch(db);
    splits.forEach(split => {
        const ref = doc(collection(db, 'transactions'));
        batch.set(ref, {
            categoryId:   split.categoryId,
            categoryName: split.categoryName,
            type:         'deposit',
            amount:       split.amount,
            note:         label || '',
            splitGroupId,
            userId:       state.user.uid,
            timestamp:    serverTimestamp(),
        });
    });
    await batch.commit();
}

async function deleteTransaction(id) {
    await deleteDoc(doc(db, 'transactions', id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-time listeners
// ─────────────────────────────────────────────────────────────────────────────

function setupListeners(userId) {
    teardownListeners();

    // ── Categories ──
    const catsQ = query(collection(db, 'categories'), where('userId', '==', userId));

    unsubCats = onSnapshot(catsQ, async (snap) => {
        // First-login: seed defaults when the collection is empty.
        if (snap.empty && !isSeeding) {
            isSeeding = true;
            try { await seedDefaultCategories(userId); }
            catch (e) { console.error('[App] Seeding failed:', e); isSeeding = false; }
            return; // The seed write will fire another snapshot.
        }
        isSeeding = false;

        state.categories.clear();
        snap.forEach(d => state.categories.set(d.id, { id: d.id, ...d.data() }));
        renderCurrentView();
    }, firestoreError);

    // ── All transactions (used for balance computation everywhere) ──
    const txnsQ = query(collection(db, 'transactions'), where('userId', '==', userId));

    unsubTxns = onSnapshot(txnsQ, (snap) => {
        state.transactions = [];
        snap.forEach(d => state.transactions.push({ id: d.id, ...d.data() }));
        // Sort newest first (seconds may be null for pending server timestamps).
        state.transactions.sort((a, b) =>
            (b.timestamp?.seconds ?? 0) - (a.timestamp?.seconds ?? 0));
        renderCurrentView();
    }, firestoreError);
}

function teardownListeners() {
    if (unsubCats) { unsubCats(); unsubCats = null; }
    if (unsubTxns) { unsubTxns(); unsubTxns = null; }
}

function firestoreError(err) {
    console.error('[Firestore]', err);
    switch (err.code) {
        case 'permission-denied':
            showToast('Permission denied — try signing out and back in.', 'error'); break;
        case 'unavailable':
            showToast('Offline — showing cached data.', 'info'); break;
        default:
            showToast(`Data error: ${err.message}`, 'error');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

function navigate(view, params = {}) {
    currentView  = view;
    currentCatId = params.categoryId ?? null;
    renderCurrentView();
}

function renderCurrentView() {
    switch (currentView) {
        case 'home':     renderHome();                        break;
        case 'category': renderCategoryDetail(currentCatId); break;
        case 'manage':   renderManageCategories();            break;
        case 'ledger':   renderLedger();                      break;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// View: Home
// ─────────────────────────────────────────────────────────────────────────────

function renderHome() {
    const vc = document.getElementById('view-container');
    if (!vc) return;

    document.getElementById('header-title').textContent = '💰 My Savings';
    document.getElementById('btn-back').style.display   = 'none';

    // Compute per-category balances from the flat transactions array.
    const balances = new Map();
    state.categories.forEach((_, id) => balances.set(id, 0));
    state.transactions.forEach(t => {
        const delta = t.type === 'deposit' ? t.amount : -t.amount;
        balances.set(t.categoryId, (balances.get(t.categoryId) ?? 0) + delta);
    });

    const totalSavings = [...balances.values()].reduce((s, b) => s + b, 0);

    // Sort categories by creation order.
    const cats = [...state.categories.values()]
        .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));

    const catCards = cats.map(cat => {
        const bal = balances.get(cat.id) ?? 0;
        const { accent, light } = catColors(cat);
        const balClass = bal < 0 ? 'negative' : 'positive';
        return `
          <div class="cat-card" data-id="${cat.id}"
               style="border-left-color:${accent}; background:${light}">
            <div class="cat-card-left">
              <div class="cat-card-name">${escapeHTML(cat.name)}</div>
              <div class="cat-card-meta">
                ${cat.allocationPercent}% allocation${cat.isDefault ? ' · <strong>Default</strong>' : ''}
              </div>
            </div>
            <div class="cat-card-balance ${balClass}">${fmt(bal)}</div>
            <span class="cat-card-arrow">›</span>
          </div>`;
    }).join('');

    const heroClass = totalSavings < 0 ? 'negative' : '';
    vc.innerHTML = `
      <div class="hero">
        <div class="hero-label">Total Savings</div>
        <div class="hero-amount ${heroClass}">${fmt(totalSavings)}</div>
        <div class="hero-sub">Across ${cats.length} categories</div>
      </div>

      <div class="action-row">
        <button class="btn btn-primary" id="btn-deposit">＋ Add Money</button>
        <button class="btn btn-outline-dark" id="btn-withdraw">－ Withdraw</button>
      </div>

      <div class="section-label">Categories</div>
      <div class="category-list">
        ${catCards || '<p class="state-msg">Loading categories…</p>'}
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:4px">
        <button class="btn btn-ghost" id="btn-ledger">
          📋&thinsp; All Transactions
        </button>
        <button class="btn btn-ghost" id="btn-manage">
          ⚙&thinsp; Manage Categories
        </button>
      </div>`;

    document.getElementById('btn-deposit') .addEventListener('click', () => openDepositModal());
    document.getElementById('btn-withdraw').addEventListener('click', () => openWithdrawModal());
    document.getElementById('btn-ledger')  .addEventListener('click', () => navigate('ledger'));
    document.getElementById('btn-manage')  .addEventListener('click', () => navigate('manage'));
    vc.querySelectorAll('.cat-card').forEach(el =>
        el.addEventListener('click', () => navigate('category', { categoryId: el.dataset.id })));
}

// ─────────────────────────────────────────────────────────────────────────────
// View: Category detail
// ─────────────────────────────────────────────────────────────────────────────

function renderCategoryDetail(categoryId) {
    const vc  = document.getElementById('view-container');
    const cat = state.categories.get(categoryId);
    if (!vc || !cat) { navigate('home'); return; }

    const { accent, light } = catColors(cat);

    document.getElementById('header-title').textContent = cat.name;
    const backBtn = document.getElementById('btn-back');
    backBtn.style.display = 'inline-flex';
    backBtn.onclick = () => navigate('home');

    // Compute this category's balance and filter its transactions.
    const txns = state.transactions.filter(t => t.categoryId === categoryId);
    const balance = txns.reduce((s, t) =>
        s + (t.type === 'deposit' ? t.amount : -t.amount), 0);

    const txnRows = txns.map(txn => {
        const isDeposit = txn.type === 'deposit';
        const sign      = isDeposit ? '+' : '−';
        const cls       = isDeposit ? 'positive' : 'negative';
        const noteTxt      = txn.note ? `<span class="txn-note">${escapeHTML(txn.note)}</span>` : '';
        const splitBadge    = txn.splitGroupId    ? '<span class="split-badge">split</span>' : '';
        const transferBadge = txn.transferGroupId ? '<span class="split-badge" style="background:#fff8e1;color:#f57f17">transfer</span>' : '';
        return `
          <div class="txn-row">
            <div class="txn-left">
              <div class="txn-date">${fmtDate(txn.timestamp)}</div>
              <div>${noteTxt}${splitBadge}${transferBadge}</div>
            </div>
            <div class="txn-right">
              <span class="txn-amount ${cls}">${sign}${fmt(txn.amount)}</span>
              <button class="txn-del" data-id="${txn.id}" aria-label="Delete">🗑</button>
            </div>
          </div>`;
    }).join('');

    const balClass = balance < 0 ? 'negative' : '';
    vc.innerHTML = `
      <div class="detail-hero" style="background:${light}; border-left:5px solid ${accent}">
        <div class="detail-cat-name" style="color:${accent}">${escapeHTML(cat.name)}</div>
        <div class="detail-balance ${balClass}" style="color:${balance < 0 ? '' : accent}">
          ${balance < 0 ? '−' : ''}${fmt(balance)}
        </div>
        <div class="detail-alloc">
          ${cat.allocationPercent}% allocation${cat.isDefault ? ' · Default rounding category' : ''}
        </div>
      </div>

      <div class="action-row">
        <button class="btn btn-primary"      id="btn-cat-dep">＋ Deposit Here</button>
        <button class="btn btn-outline-dark" id="btn-cat-wd">－ Withdraw</button>
      </div>

      <div class="section-label">Transactions</div>
      <div class="card" style="padding:0 16px">
        <div class="txn-list">
          ${txnRows || '<p class="state-msg">No transactions yet.</p>'}
        </div>
      </div>`;

    document.getElementById('btn-cat-dep').addEventListener('click', () => openDepositModal(categoryId));
    document.getElementById('btn-cat-wd') .addEventListener('click', () => openWithdrawModal(categoryId));

    vc.querySelectorAll('.txn-del[data-id]').forEach(btn =>
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this transaction?')) return;
            try {
                await deleteTransaction(btn.dataset.id);
                showToast('Transaction deleted.', 'info');
            } catch (e) {
                showToast('Error deleting transaction.', 'error');
            }
        })
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// View: Manage categories
// ─────────────────────────────────────────────────────────────────────────────

function renderManageCategories() {
    const vc = document.getElementById('view-container');
    if (!vc) return;

    document.getElementById('header-title').textContent = 'Manage Categories';
    const backBtn = document.getElementById('btn-back');
    backBtn.style.display = 'inline-flex';
    backBtn.onclick = () => navigate('home');

    const cats = [...state.categories.values()]
        .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));

    const totalAlloc = cats.reduce((s, c) => s + c.allocationPercent, 0);
    const allocCls   = totalAlloc === 100 ? 'ok' : totalAlloc > 100 ? 'over' : 'under';
    const allocMsg   = totalAlloc === 100
        ? '✓ 100% — fully allocated'
        : `${totalAlloc}% — ${totalAlloc > 100 ? `${totalAlloc - 100}% over` : `${100 - totalAlloc}% remaining`}`;

    const rows = cats.map(cat => {
        const { accent } = catColors(cat);
        const defaultNote = cat.isDefault ? ' · Default' : '';
        return `
          <div class="manage-row" style="border-left-color:${accent}">
            <div>
              <div class="manage-cat-name">${escapeHTML(cat.name)}</div>
              <div class="manage-cat-alloc">${cat.allocationPercent}%${defaultNote}</div>
            </div>
            <div class="manage-actions">
              <button class="btn btn-sm btn-outline-dark" data-edit="${cat.id}">Edit</button>
              <button class="btn btn-sm btn-danger-outline" data-del="${cat.id}">Delete</button>
            </div>
          </div>`;
    }).join('');

    vc.innerHTML = `
      <div class="alloc-bar">
        <span class="alloc-bar-label">Total allocation</span>
        <span class="alloc-total ${allocCls}">${allocMsg}</span>
      </div>

      <div class="section-label">Categories</div>
      <div class="manage-list">
        ${rows || '<p class="state-msg">No categories yet.</p>'}
      </div>

      <button class="btn btn-primary btn-full" id="btn-add-cat">＋ Add Category</button>`;

    document.getElementById('btn-add-cat').addEventListener('click', () => openCategoryModal());

    vc.querySelectorAll('[data-edit]').forEach(btn =>
        btn.addEventListener('click', () => openCategoryModal(btn.dataset.edit)));

    vc.querySelectorAll('[data-del]').forEach(btn =>
        btn.addEventListener('click', async () => {
            const cat = state.categories.get(btn.dataset.del);
            if (!cat) return;

            if (cat.isDefault) {
                showToast('Set another category as Default before deleting this one.', 'error');
                return;
            }

            // Compute current balance for this category.
            const balance = state.transactions
                .filter(t => t.categoryId === cat.id)
                .reduce((s, t) => s + (t.type === 'deposit' ? t.amount : -t.amount), 0);

            if (balance > 0.004) {
                // Category has money — require a transfer before deletion.
                openTransferAndDeleteModal(cat, balance);
            } else {
                // Empty (or negligible) balance — simple confirmation.
                if (!confirm(`Delete "${cat.name}"?`)) return;
                try {
                    await deleteCategory(cat.id);
                    showToast(`"${cat.name}" deleted.`, 'info');
                } catch (e) {
                    showToast('Error deleting category.', 'error');
                }
            }
        })
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// View: All Transactions (ledger)
//
// Shows every transaction across all categories, newest first, grouped by
// calendar date. categoryName is read from the transaction document itself
// (it was denormalized at write time) so entries from deleted categories
// still display correctly.
// ─────────────────────────────────────────────────────────────────────────────

function renderLedger() {
    const vc = document.getElementById('view-container');
    if (!vc) return;

    document.getElementById('header-title').textContent = 'All Transactions';
    const backBtn = document.getElementById('btn-back');
    backBtn.style.display = 'inline-flex';
    backBtn.onclick = () => navigate('home');

    if (state.transactions.length === 0) {
        vc.innerHTML = '<p class="state-msg">No transactions yet.</p>';
        return;
    }

    // Group transactions by calendar date.
    const groups = new Map(); // "YYYY-MM-DD" → { label, txns[] }
    state.transactions.forEach(txn => {
        const d   = txn.timestamp ? txn.timestamp.toDate() : new Date();
        const key = d.toISOString().slice(0, 10);
        const lbl = d.toLocaleDateString('en-US',
            { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        if (!groups.has(key)) groups.set(key, { label: lbl, txns: [] });
        groups.get(key).txns.push(txn);
    });

    const grandTotal = state.transactions.reduce((s, t) =>
        s + (t.type === 'deposit' ? t.amount : -t.amount), 0);

    const groupHTML = [...groups.entries()]
        .sort(([a], [b]) => b.localeCompare(a)) // newest date first
        .map(([, { label, txns }]) => {
            const dayNet     = txns.reduce((s, t) =>
                s + (t.type === 'deposit' ? t.amount : -t.amount), 0);
            const dayNetSign = dayNet >= 0 ? '+' : '−';
            const dayNetCls  = dayNet >= 0 ? 'positive' : 'negative';

            const rows = txns.map(txn => {
                const isDeposit  = txn.type === 'deposit';
                const sign       = isDeposit ? '+' : '−';
                const amtCls     = isDeposit ? 'positive' : 'negative';

                // Category color — falls back gracefully if category was deleted.
                const cat        = state.categories.get(txn.categoryId);
                const { accent } = catColors(cat);

                const splitBadge    = txn.splitGroupId
                    ? '<span class="split-badge">split</span>' : '';
                const transferBadge = txn.transferGroupId
                    ? '<span class="split-badge" style="background:#fff8e1;color:#f57f17">transfer</span>' : '';
                const deletedBadge  = !cat
                    ? '<span class="split-badge" style="background:#fce4ec;color:#c62828">deleted</span>' : '';
                const noteTxt = txn.note
                    ? `<span class="txn-note">${escapeHTML(txn.note)}</span>` : '';

                return `
                  <div class="txn-row">
                    <div class="txn-left">
                      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;
                                     background:${accent};flex-shrink:0"></span>
                        <span style="font-weight:700;font-size:0.9rem">
                          ${escapeHTML(txn.categoryName)}
                        </span>
                        ${deletedBadge}${splitBadge}${transferBadge}
                      </div>
                      <div style="margin-top:3px">${noteTxt}</div>
                    </div>
                    <div class="txn-right">
                      <span class="txn-amount ${amtCls}">${sign}${fmt(txn.amount)}</span>
                      <button class="txn-del" data-id="${txn.id}" aria-label="Delete">🗑</button>
                    </div>
                  </div>`;
            }).join('');

            return `
              <div style="margin-bottom:18px">
                <div style="display:flex;justify-content:space-between;align-items:baseline;
                            margin-bottom:6px">
                  <span class="section-label" style="margin:0">${label}</span>
                  <span class="${dayNetCls}" style="font-size:0.8rem;font-weight:700">
                    ${dayNetSign}${fmt(Math.abs(dayNet))}
                  </span>
                </div>
                <div class="card" style="padding:0 16px">
                  <div class="txn-list">${rows}</div>
                </div>
              </div>`;
        }).join('');

    vc.innerHTML = `
      <div class="hero" style="margin-bottom:16px">
        <div class="hero-label">Net Balance</div>
        <div class="hero-amount ${grandTotal < 0 ? 'negative' : ''}">${grandTotal < 0 ? '−' : ''}${fmt(grandTotal)}</div>
        <div class="hero-sub">${state.transactions.length} transaction${state.transactions.length !== 1 ? 's' : ''}</div>
      </div>
      ${groupHTML}`;

    vc.querySelectorAll('.txn-del[data-id]').forEach(btn =>
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this transaction?')) return;
            try {
                await deleteTransaction(btn.dataset.id);
                showToast('Transaction deleted.', 'info');
            } catch (e) {
                showToast('Error deleting transaction.', 'error');
            }
        })
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal: Deposit
//
// Two modes:
//   "Split by allocation" — splits the entered amount across all categories
//     that have allocationPercent > 0. A live preview table updates as the
//     user types. The label ties all rows to the same deposit event.
//   "One category" — deposits the full amount into one chosen category.
// ─────────────────────────────────────────────────────────────────────────────

function openDepositModal(preselectedCategoryId = null) {
    const startMode  = preselectedCategoryId ? 'single' : 'split';
    const catOptions = sortedCatOptions(preselectedCategoryId);

    showModal(`
      <h2 class="modal-title">Add Money</h2>

      <div class="form-group">
        <label class="field-label">Amount ($)</label>
        <input type="number" id="dep-amount" step="0.01" min="0.01"
               placeholder="e.g. 228.41" inputmode="decimal">
      </div>

      <div class="form-group">
        <label class="field-label">Label <span class="optional">(optional)</span></label>
        <input type="text" id="dep-label" maxlength="60"
               placeholder="e.g. March allowance, Birthday from Grandma">
      </div>

      <div class="mode-tabs">
        <button class="mode-tab ${startMode === 'split'  ? 'active' : ''}"
                data-mode="split">Split by allocation</button>
        <button class="mode-tab ${startMode === 'single' ? 'active' : ''}"
                data-mode="single">One category</button>
      </div>

      <!-- Split preview (shown in split mode) -->
      <div id="dep-split-pane" style="display:${startMode === 'split' ? 'block' : 'none'}">
        <div id="split-preview"></div>
      </div>

      <!-- Single category picker (shown in single mode) -->
      <div id="dep-single-pane" style="display:${startMode === 'single' ? 'block' : 'none'}">
        <div class="form-group">
          <label class="field-label">Category</label>
          <select id="dep-category">${catOptions}</select>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn btn-ghost"    id="btn-dep-cancel">Cancel</button>
        <button class="btn btn-primary"  id="btn-dep-confirm">Add Money</button>
      </div>`);

    // ── Mode tab switching ──
    document.querySelectorAll('.mode-tab').forEach(tab =>
        tab.addEventListener('click', () => {
            document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const isSplit = tab.dataset.mode === 'split';
            document.getElementById('dep-split-pane').style.display  = isSplit ? 'block' : 'none';
            document.getElementById('dep-single-pane').style.display = isSplit ? 'none'  : 'block';
            refreshSplitPreview();
        })
    );

    // ── Live split preview ──
    function refreshSplitPreview() {
        const previewEl = document.getElementById('split-preview');
        if (!previewEl) return;
        const isSplit = document.querySelector('.mode-tab[data-mode="split"]')?.classList.contains('active');
        if (!isSplit) return;

        const amount = parseFloat(document.getElementById('dep-amount')?.value);
        if (!amount || amount <= 0) { previewEl.innerHTML = ''; return; }

        const splits = calculateSplit(amount);
        if (splits.length === 0) {
            previewEl.innerHTML = '<p class="form-hint">No categories have an allocation set.</p>';
            return;
        }

        const rows = splits.map(s => {
            const { accent } = { accent: s.accent };
            const roundNote  = s.hasRemainder
                ? '<span class="rounding-note">(incl. rounding)</span>' : '';
            return `
              <tr>
                <td><span class="split-dot" style="background:${accent}"></span>
                    ${escapeHTML(s.categoryName)}</td>
                <td>${s.allocationPercent > 0 ? s.allocationPercent + '%' : '—'}${roundNote}</td>
                <td class="positive">+${fmt(s.amount)}</td>
              </tr>`;
        }).join('');

        previewEl.innerHTML = `
          <div class="split-preview">
            <table class="split-table">
              <thead>
                <tr><th>Category</th><th>%</th><th>Amount</th></tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr>
                  <td colspan="2">Total</td>
                  <td>+${fmt(amount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>`;
    }

    document.getElementById('dep-amount').addEventListener('input', refreshSplitPreview);
    document.getElementById('dep-cancel', refreshSplitPreview); // no-op — just calling refresh once
    refreshSplitPreview();

    // ── Cancel / confirm ──
    document.getElementById('btn-dep-cancel') .addEventListener('click', closeModal);
    document.getElementById('btn-dep-confirm').addEventListener('click', async () => {
        const amount = parseFloat(document.getElementById('dep-amount').value);
        const label  = document.getElementById('dep-label').value.trim();
        const isSplit = document.querySelector('.mode-tab[data-mode="split"]')?.classList.contains('active');

        if (!amount || amount <= 0) {
            showToast('Please enter a valid amount greater than $0.', 'error');
            document.getElementById('dep-amount').focus();
            return;
        }

        const confirmBtn = document.getElementById('btn-dep-confirm');
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Saving…';

        try {
            if (isSplit) {
                // Enforce 100% here — this is the only place where the total
                // actually affects the split math. Editing individual categories
                // is allowed at any total so the user can adjust in multiple steps.
                const totalAlloc = [...state.categories.values()]
                    .reduce((s, c) => s + c.allocationPercent, 0);
                if (totalAlloc !== 100) {
                    showToast(
                        `Allocations total ${totalAlloc}% — they must equal 100% before splitting. Go to Manage Categories to fix this.`,
                        'error'
                    );
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = 'Add Money';
                    return;
                }
                const splits = calculateSplit(amount);
                if (splits.length === 0) {
                    showToast('No categories have an allocation set. Use "One category" instead.', 'error');
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = 'Add Money';
                    return;
                }
                await addSplitTransactions(splits, label);
                showToast(`${fmt(amount)} split across ${splits.length} categories.`, 'success');
            } else {
                const catId = document.getElementById('dep-category')?.value;
                const cat   = state.categories.get(catId);
                if (!cat) { showToast('Please select a category.', 'error'); return; }
                await addTransaction({
                    categoryId:   cat.id,
                    categoryName: cat.name,
                    type:         'deposit',
                    amount,
                    note:         label,
                });
                showToast(`+${fmt(amount)} deposited to ${cat.name}.`, 'success');
            }
            closeModal();
        } catch (e) {
            console.error('[Deposit]', e);
            showToast('Error saving — please try again.', 'error');
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Add Money';
        }
    });

    document.getElementById('dep-amount').focus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal: Withdraw
// ─────────────────────────────────────────────────────────────────────────────

function openWithdrawModal(preselectedCategoryId = null) {
    const catOptions = sortedCatOptions(preselectedCategoryId);

    showModal(`
      <h2 class="modal-title">Withdraw</h2>

      <div class="form-group">
        <label class="field-label">From Category</label>
        <select id="wd-cat">${catOptions}</select>
        <p class="balance-hint" id="wd-bal"></p>
      </div>

      <div class="form-group">
        <label class="field-label">Amount ($)</label>
        <input type="number" id="wd-amount" step="0.01" min="0.01"
               placeholder="e.g. 15.00" inputmode="decimal">
      </div>

      <div class="form-group">
        <label class="field-label">Note <span class="optional">(optional)</span></label>
        <input type="text" id="wd-note" maxlength="60"
               placeholder="e.g. Ice cream, Movie ticket">
      </div>

      <div class="modal-actions">
        <button class="btn btn-ghost"   id="btn-wd-cancel">Cancel</button>
        <button class="btn btn-danger"  id="btn-wd-confirm">Withdraw</button>
      </div>`);

    function updateBalHint() {
        const catId = document.getElementById('wd-cat')?.value;
        const hint  = document.getElementById('wd-bal');
        if (!catId || !hint) return;
        const bal = state.transactions
            .filter(t => t.categoryId === catId)
            .reduce((s, t) => s + (t.type === 'deposit' ? t.amount : -t.amount), 0);
        hint.textContent = `Current balance: ${fmt(bal)}`;
        hint.className   = `balance-hint${bal < 0 ? ' negative' : ''}`;
    }

    updateBalHint();
    document.getElementById('wd-cat')?.addEventListener('change', updateBalHint);
    document.getElementById('btn-wd-cancel').addEventListener('click', closeModal);

    document.getElementById('btn-wd-confirm').addEventListener('click', async () => {
        const catId  = document.getElementById('wd-cat')?.value;
        const amount = parseFloat(document.getElementById('wd-amount')?.value);
        const note   = document.getElementById('wd-note')?.value.trim();
        const cat    = state.categories.get(catId);

        if (!cat)                { showToast('Please select a category.', 'error'); return; }
        if (!amount || amount <= 0) { showToast('Please enter a valid amount.', 'error'); return; }

        // Warn (but don't block) if the withdrawal exceeds the current balance.
        const bal = state.transactions
            .filter(t => t.categoryId === catId)
            .reduce((s, t) => s + (t.type === 'deposit' ? t.amount : -t.amount), 0);
        if (amount > bal) {
            const ok = confirm(
                `This withdrawal (${fmt(amount)}) exceeds the current balance (${fmt(bal)}).\n\nProceed anyway?`
            );
            if (!ok) return;
        }

        const btn = document.getElementById('btn-wd-confirm');
        btn.disabled = true;
        btn.textContent = 'Saving…';

        try {
            await addTransaction({
                categoryId:   cat.id,
                categoryName: cat.name,
                type:         'withdrawal',
                amount,
                note: note || '',
            });
            showToast(`−${fmt(amount)} withdrawn from ${cat.name}.`, 'info');
            closeModal();
        } catch (e) {
            console.error('[Withdraw]', e);
            showToast('Error saving — please try again.', 'error');
            btn.disabled = false;
            btn.textContent = 'Withdraw';
        }
    });

    document.getElementById('wd-amount')?.focus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal: Add / Edit category
//
// Allocation rules enforced here:
//   • Whole numbers only (step="1").
//   • Minimum 1% (or 0% if the user explicitly wants to exclude from splits).
//   • Total across all categories must equal exactly 100% before saving.
//   • Only one category can be the default.
// ─────────────────────────────────────────────────────────────────────────────

function openCategoryModal(categoryId = null) {
    const cat = categoryId ? state.categories.get(categoryId) : null;

    // Default color: use the category's stored color, or derive from palette.
    const defaultColor = cat?.color
        ?? (cat ? catColors(cat).accent : PALETTE[state.categories.size % PALETTE.length].accent);

    showModal(`
      <h2 class="modal-title">${cat ? 'Edit Category' : 'Add Category'}</h2>

      <div class="form-group">
        <label class="field-label">Category Name</label>
        <input type="text" id="cat-name" maxlength="30"
               value="${escapeHTML(cat?.name ?? '')}"
               placeholder="e.g. Car Fund">
      </div>

      <div class="form-group">
        <label class="field-label">Allocation %</label>
        <input type="number" id="cat-alloc" min="0" max="100" step="1"
               value="${cat?.allocationPercent ?? 0}">
        <p class="form-hint">
          Use 0 to exclude this category from auto-splits.
          Otherwise minimum 1%, whole numbers only.
          All allocations must add up to exactly 100%.
        </p>
        <p class="alloc-warning" id="alloc-warn"></p>
      </div>

      <div class="form-group">
        <label class="field-label">Color</label>
        <div style="display:flex;gap:10px;align-items:center">
          <input type="color" id="cat-color-picker" value="${defaultColor}"
                 style="width:44px;height:38px;border:1.5px solid #ddd;border-radius:8px;
                        cursor:pointer;padding:2px;flex-shrink:0">
          <input type="text"  id="cat-color-text"   value="${defaultColor}"
                 placeholder="#4caf50 or teal" style="flex:1">
        </div>
        <p class="form-hint">Enter a hex value (e.g. #4caf50) or any CSS color name (e.g. teal, coral).</p>
      </div>

      <div class="form-group checkbox-group">
        <label>
          <input type="checkbox" id="cat-default" ${cat?.isDefault ? 'checked' : ''}>
          Default rounding category — receives leftover cents from split deposits
        </label>
      </div>

      <div class="modal-actions">
        <button class="btn btn-ghost"   id="btn-cat-cancel">Cancel</button>
        <button class="btn btn-primary" id="btn-cat-save">
          ${cat ? 'Save Changes' : 'Add Category'}
        </button>
      </div>`);

    // ── Live allocation total indicator ──
    function updateAllocWarning() {
        const input   = document.getElementById('cat-alloc');
        const warnEl  = document.getElementById('alloc-warn');
        const newVal  = parseInt(input?.value ?? '0', 10) || 0;
        const oldVal  = cat?.allocationPercent ?? 0;

        // Sum all existing allocations, replacing this category's old value.
        const otherTotal = [...state.categories.values()]
            .filter(c => c.id !== categoryId)
            .reduce((s, c) => s + c.allocationPercent, 0);

        const projectedTotal = otherTotal + newVal;
        const diff = 100 - projectedTotal;

        if (!warnEl) return;
        if (projectedTotal === 100) {
            warnEl.textContent = '✓ Total will be exactly 100%';
            warnEl.className   = 'alloc-warning ok';
        } else if (projectedTotal > 100) {
            warnEl.textContent = `Total will be ${projectedTotal}% — ${projectedTotal - 100}% over`;
            warnEl.className   = 'alloc-warning over';
        } else {
            warnEl.textContent = `Total will be ${projectedTotal}% — ${diff}% remaining`;
            warnEl.className   = 'alloc-warning under';
        }
    }

    document.getElementById('cat-alloc').addEventListener('input', updateAllocWarning);
    updateAllocWarning();

    // ── Color picker ↔ text field sync ──
    const colorPicker = document.getElementById('cat-color-picker');
    const colorText   = document.getElementById('cat-color-text');

    colorPicker.addEventListener('input', () => {
        colorText.value = colorPicker.value;
    });
    colorText.addEventListener('change', () => {
        const hex = parseColorInput(colorText.value.trim());
        if (hex) {
            colorPicker.value = hex;
            colorText.value   = hex;
        } else {
            showToast('Unrecognised color — try a hex value like #4caf50 or a name like teal.', 'error');
        }
    });

    document.getElementById('btn-cat-cancel').addEventListener('click', closeModal);

    document.getElementById('btn-cat-save').addEventListener('click', async () => {
        const name      = document.getElementById('cat-name').value.trim();
        const allocRaw  = document.getElementById('cat-alloc').value;
        const alloc     = parseInt(allocRaw, 10);
        const isDefault = document.getElementById('cat-default').checked;
        const color     = document.getElementById('cat-color-picker').value;

        // ── Validation ──
        if (!name) {
            showToast('Please enter a category name.', 'error');
            document.getElementById('cat-name').focus();
            return;
        }
        if (isNaN(alloc) || alloc < 0 || alloc > 100 || !Number.isInteger(alloc)) {
            showToast('Allocation must be a whole number between 0 and 100.', 'error');
            return;
        }
        if (alloc > 0 && alloc < 1) {
            showToast('Minimum allocation is 1% (or 0% to exclude from splits).', 'error');
            return;
        }

        // Advisory check only — do not block saves mid-edit.
        // The manage view's colour-coded total already communicates the state.
        // The split deposit flow enforces 100% at the point where it matters.

        const btn = document.getElementById('btn-cat-save');
        btn.disabled = true;

        try {
            await saveCategory(
                { name, allocationPercent: alloc, isDefault, color },
                categoryId ?? null
            );
            showToast(cat ? 'Category updated.' : 'Category added.', 'success');
            closeModal();
        } catch (e) {
            console.error('[Category save]', e);
            showToast('Error saving category.', 'error');
            btn.disabled = false;
        }
    });

    document.getElementById('cat-name')?.focus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shows a modal prompting the user to pick a destination category for the
 * remaining balance before the source category is deleted.
 */
function openTransferAndDeleteModal(cat, balance) {
    const otherCats = [...state.categories.values()]
        .filter(c => c.id !== cat.id)
        .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));

    if (otherCats.length === 0) {
        showToast('Create another category before deleting this one.', 'error');
        return;
    }

    const defaultTarget = otherCats.find(c => c.isDefault) ?? otherCats[0];
    const options = otherCats
        .map(c => `<option value="${c.id}" ${c.id === defaultTarget.id ? 'selected' : ''}>${escapeHTML(c.name)}</option>`)
        .join('');

    showModal(`
      <h3 class="modal-title">Delete "${escapeHTML(cat.name)}"</h3>
      <p style="margin:0 0 16px;line-height:1.5">
        This category has a balance of <strong>${fmt(balance)}</strong>.
        Transfer it to another category before deleting.
      </p>
      <label class="field-label">Transfer balance to</label>
      <select id="transfer-target" class="field-input">${options}</select>
      <div class="modal-actions">
        <button class="btn btn-outline-dark" id="btn-transfer-cancel">Cancel</button>
        <button class="btn btn-danger"       id="btn-transfer-confirm">Transfer &amp; Delete</button>
      </div>`);

    document.getElementById('btn-transfer-cancel').addEventListener('click', closeModal);

    document.getElementById('btn-transfer-confirm').addEventListener('click', async () => {
        const targetId = document.getElementById('transfer-target').value;
        const toCat    = state.categories.get(targetId);
        if (!toCat) { showToast('Please select a target category.', 'error'); return; }

        const confirmBtn = document.getElementById('btn-transfer-confirm');
        confirmBtn.disabled    = true;
        confirmBtn.textContent = 'Saving…';

        try {
            await addTransferTransactions(cat, toCat, balance);
            await deleteCategory(cat.id);
            closeModal();
            showToast(`${fmt(balance)} transferred to ${toCat.name}. "${cat.name}" deleted.`, 'success');
        } catch (e) {
            console.error('[TransferDelete]', e);
            showToast('Error — please try again.', 'error');
            confirmBtn.disabled    = false;
            confirmBtn.textContent = 'Transfer & Delete';
        }
    });
}

function showModal(html) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    content.innerHTML = html;
    overlay.classList.add('open');
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); }, { once: true });
}

function closeModal() {
    document.getElementById('modal-overlay')?.classList.remove('open');
    document.getElementById('modal-content').innerHTML = '';
}

/** Returns <option> elements for all categories, sorted by creation order. */
function sortedCatOptions(selectedId = null) {
    return [...state.categories.values()]
        .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0))
        .map(c => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>
                     ${escapeHTML(c.name)}
                   </option>`)
        .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────

async function signInWithGoogle() {
    const btn = document.getElementById('btn-signin');
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    try {
        await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
        console.error('[Auth]', e);
        switch (e.code) {
            case 'auth/popup-closed-by-user': showToast('Sign-in cancelled.', 'info'); break;
            case 'auth/popup-blocked':        showToast('Pop-up blocked — please allow pop-ups.', 'error'); break;
            default: showToast(`Sign-in error: ${e.message}`, 'error');
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Sign in with Google'; }
    }
}

async function signOutUser() {
    teardownListeners();
    try { await signOut(auth); showToast('Signed out.', 'info'); }
    catch (e) { showToast('Sign-out failed — please try again.', 'error'); }
}

onAuthStateChanged(auth, user => {
    state.user = user;
    const authSection = document.getElementById('auth-section');
    const appSection  = document.getElementById('app-section');
    const signOutBtn  = document.getElementById('btn-signout');

    if (user) {
        authSection.style.display = 'none';
        appSection.style.display  = 'block';
        signOutBtn.style.display  = 'inline-flex';
        currentView  = 'home';
        currentCatId = null;
        setupListeners(user.uid);
    } else {
        authSection.style.display = 'flex';
        appSection.style.display  = 'none';
        signOutBtn.style.display  = 'none';
        state.categories.clear();
        state.transactions = [];
        closeModal();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Persistent event listeners (elements that are never re-rendered)
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('btn-signin') .addEventListener('click', signInWithGoogle);
document.getElementById('btn-signout').addEventListener('click', signOutUser);

console.log('[App] Savings Tracker v2 ready.');
