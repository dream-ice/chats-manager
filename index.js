import {
    chat_metadata,
    doNewChat,
    event_types,
    getRequestHeaders,
    importCharacterChat,
    openCharacterChat,
    renameGroupOrCharacterChat,
    selectCharacterById,
    deleteCharacterChatByName,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { t } from '../../../i18n.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { download, getStringHash, humanFileSize, timestampToMoment } from '../../../utils.js';

const MODULE_NAME = 'chatsManager';
const ROOT_ID = 'chats-manager-root';
const DEFAULT_SETTINGS = Object.freeze({
    defaultTab: 'characters',
    pinnedChats: [],
    libraries: {},
    collapsedCharacters: {},
    collapsedFolders: {},
    collapsedPinned: false,
    sortMode: 'recent',
    pageSize: 10,
});

let panel = null;
let chatsPanel = null;
let activateTab = null;
let refreshBackups = null;
let loadGeneration = 0;
const characterChatCache = new Map();
const pendingCharacterLoads = new Map();
const pendingCharacterDetails = new Map();
const CHAT_LOAD_CONCURRENCY = 4;
const CHAT_SUMMARY_TIMEOUT_MS = 8000;
const CHAT_DETAIL_TIMEOUT_MS = 120000;
const CHAT_INDEX_TIMEOUT_MS = 30000;
const CHAT_DETAIL_RETRY_MS = 60000;
const CHAT_DETAIL_CONCURRENCY = 1;
const CHAT_AUTO_DETAIL_MAX_BYTES = 256 * 1024 * 1024;
const CHAT_AUTO_DETAIL_MAX_FILES = 80;
const CHAT_PREVIEW_CACHE_LIMIT = 512;
const BACKUP_PAGE_SIZE = 50;
const BACKUP_PREVIEW_HEAD_BYTES = 512 * 1024;
const BACKUP_PREVIEW_TAIL_BYTES = 1024 * 1024;
const BACKUP_PREVIEW_SIDE_MAX = 20;
const BACKUP_IDENTITY_MAX_BYTES = 32 * 1024;
const BACKUP_HISTORY_DEFAULT_PAGE_SIZE = 20;
let detailRefreshTimer = null;
let activeDetailLoads = 0;
const detailLoadWaiters = [];
let characterCacheEpoch = 0;
let currentPage = 1;
let browseAllCharacters = false;
let nativeChatObserver = null;
let nativeGroupingTimer = null;
let nativeGroupingGeneration = 0;
let nativeBatchMode = false;
let nativeBatchCharacterKey = '';
let parentButtonValidationGeneration = 0;
const nativeSelectedChats = new Set();
let chatsBatchMode = false;
let chatsBatchBusy = false;
const chatsSelectedChats = new Map();
const renderedChats = new Map();

function settings() {
    extension_settings[MODULE_NAME] ??= structuredClone(DEFAULT_SETTINGS);
    const value = extension_settings[MODULE_NAME];
    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
        value[key] ??= structuredClone(fallback);
    }
    return value;
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getLibrary(characterKey) {
    const all = settings().libraries;
    all[characterKey] ??= { folders: [], chatFolders: {}, chatAliases: {} };
    all[characterKey].folders ??= [];
    all[characterKey].chatFolders ??= {};
    all[characterKey].chatAliases ??= {};
    return all[characterKey];
}

function chatName(value) {
    return String(value ?? '').replace(/\.jsonl$/i, '');
}

function chatPinKey(chat) {
    return `${chat.characterKey}::${chat.fileName}`;
}

function isChatPinned(chat) {
    return settings().pinnedChats.includes(chatPinKey(chat));
}

function toggleChatPin(chat) {
    const key = chatPinKey(chat);
    const pinned = settings().pinnedChats;
    const index = pinned.indexOf(key);
    if (index >= 0) pinned.splice(index, 1);
    else pinned.push(key);
    saveSettings();
}

function setChatPinned(chat, pinned) {
    const key = chatPinKey(chat);
    const current = settings().pinnedChats;
    const index = current.indexOf(key);
    if (pinned && index < 0) current.push(key);
    if (!pinned && index >= 0) current.splice(index, 1);
}

function selectedChats() {
    return [...chatsSelectedChats.values()];
}

function setChatSelected(chat, selected) {
    const key = chatPinKey(chat);
    if (selected) chatsSelectedChats.set(key, chat);
    else chatsSelectedChats.delete(key);
    updateChatsBatchUi();
}

function updateChatsBatchUi() {
    if (!chatsPanel) return;
    chatsPanel.classList.toggle('is-batch-mode', chatsBatchMode);
    const toggle = chatsPanel.querySelector('.chm-batch-toggle');
    const bar = chatsPanel.querySelector('.chm-batch-bar');
    const count = chatsPanel.querySelector('.chm-batch-count');
    const selectionCount = chatsSelectedChats.size;
    if (toggle) {
        toggle.classList.toggle('is-active', chatsBatchMode);
        toggle.title = chatsBatchMode ? '退出批量编辑' : '批量编辑聊天';
        toggle.setAttribute('aria-label', toggle.title);
        toggle.innerHTML = chatsBatchMode
            ? '<i class="fa-solid fa-xmark" aria-hidden="true"></i>'
            : '<i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>';
    }
    if (bar) {
        bar.hidden = !chatsBatchMode;
        bar.classList.toggle('is-busy', chatsBatchBusy);
        bar.querySelectorAll('[data-requires-selection]').forEach(button => {
            button.disabled = chatsBatchBusy || selectionCount === 0;
        });
        bar.querySelectorAll('button:not([data-requires-selection])').forEach(button => {
            button.disabled = chatsBatchBusy;
        });
    }
    if (count) count.textContent = `已选 ${selectionCount}`;
    const batchPin = chatsPanel.querySelector('.chm-batch-pin');
    if (batchPin) {
        const unpin = selectionCount > 0 && selectedChats().every(isChatPinned);
        batchPin.title = unpin ? '取消收藏所选聊天' : '收藏所选聊天';
        const label = batchPin.querySelector('span');
        if (label) label.textContent = unpin ? '取消收藏' : '收藏';
    }
    chatsPanel.querySelectorAll('.chm-chat-row').forEach(row => {
        const selected = chatsSelectedChats.has(row.dataset.chatKey);
        row.classList.toggle('is-selected', selected);
        const checkbox = row.querySelector('.chm-batch-checkbox');
        if (checkbox) checkbox.checked = selected;
    });
}

function characterKey(character) {
    return String(character?.avatar || character?.name || 'unknown');
}

function getCharacterName(character) {
    return String(character?.name || '未命名角色');
}

function currentChatName() {
    return chatName(SillyTavern.getContext().getCurrentChatId?.());
}

function iconButton(icon, title, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chm-icon-button ${className}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`;
    return button;
}

function makeAvatar(character, size = 'normal') {
    const liveContext = SillyTavern.getContext();
    const img = document.createElement('img');
    img.className = `chm-avatar chm-avatar-${size}`;
    img.src = liveContext.getThumbnailUrl?.('avatar', character.avatar) || `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`;
    img.alt = '';
    img.loading = 'lazy';
    return img;
}

function formatDate(value) {
    if (!value) return '';
    const date = timestampToMoment(value);
    return date?.isValid?.() ? date.format('lll') : '';
}

function pluralCount(count) {
    return `${count} ${count === 1 ? 'chat' : 'chats'}`;
}

function chatPreview(value, limit = 96) {
    const text = String(value ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text || text === '[The chat is empty]' || text === '[The message is empty]') return '';
    return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function compactChatPreview(value) {
    const text = String(value ?? '');
    return text.length > CHAT_PREVIEW_CACHE_LIMIT ? text.slice(0, CHAT_PREVIEW_CACHE_LIMIT) : text;
}

async function fetchCharacterChats(character, id, { simple = false } = {}) {
    const controller = new AbortController();
    const timeoutMs = simple ? CHAT_SUMMARY_TIMEOUT_MS : CHAT_DETAIL_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: character.avatar,
                simple,
                metadata: !simple,
            }),
            signal: controller.signal,
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (!Array.isArray(data) && (typeof data !== 'object' || data.error)) return null;
        return Object.values(data).filter(item => item?.file_name).map(item => ({
            id,
            character,
            characterKey: characterKey(character),
            fileName: chatName(item.file_name),
            message: compactChatPreview(item.mes),
            itemCount: Number(item.chat_items) || 0,
            lastMessage: item.last_mes || 0,
            metadata: {
                ...(item.chat_metadata?.main_chat ? { main_chat: item.chat_metadata.main_chat } : {}),
                ...(item.chat_metadata?.integrity ? { integrity: item.chat_metadata.integrity } : {}),
                ...(item.chat_metadata?.chat_id_hash ? { chat_id_hash: item.chat_metadata.chat_id_hash } : {}),
            },
        }));
    } catch (error) {
        const reason = error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error;
        console.warn(`[Chats Manager] Failed to load ${simple ? 'chat names' : 'chat details'} for`, getCharacterName(character), reason);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function getCharacterDescriptors() {
    const characters = SillyTavern.getContext().characters || [];
    return Object.entries(characters)
        .filter(([, character]) => character?.avatar)
        .map(([id, character]) => ({ id, character, key: characterKey(character) }));
}

function likelyHasChats(descriptor) {
    return Number(descriptor.character?.chat_size) > 0 || Number(descriptor.character?.date_last_chat) > 0;
}

function getCachedCharacter(characterKeyValue) {
    return characterChatCache.get(characterKeyValue) || null;
}

function invalidateCharacterCache(characterKeyValue = '') {
    characterCacheEpoch++;
    if (characterKeyValue) characterChatCache.delete(characterKeyValue);
    else characterChatCache.clear();
    if (characterKeyValue) pendingCharacterLoads.delete(characterKeyValue);
    else pendingCharacterLoads.clear();
}

function queueCharacterDetailsRefresh() {
    clearTimeout(detailRefreshTimer);
    detailRefreshTimer = setTimeout(() => {
        if (chatsPanel && !chatsPanel.hidden) void refreshChats(false, { background: true });
        scheduleNativeChatGrouping();
    }, 150);
}

async function acquireDetailLoadSlot() {
    if (activeDetailLoads < CHAT_DETAIL_CONCURRENCY) {
        activeDetailLoads++;
        return;
    }
    await new Promise(resolve => detailLoadWaiters.push(resolve));
}

function releaseDetailLoadSlot() {
    const next = detailLoadWaiters.shift();
    if (next) next();
    else activeDetailLoads = Math.max(0, activeDetailLoads - 1);
}

function characterDetailPolicy(entry) {
    const bytes = Math.max(0, Number(entry?.character?.chat_size) || 0);
    const files = Array.isArray(entry?.chats) ? entry.chats.length : 0;
    return {
        bytes,
        files,
        automatic: bytes <= CHAT_AUTO_DETAIL_MAX_BYTES && files <= CHAT_AUTO_DETAIL_MAX_FILES,
    };
}

function scheduleCharacterDetails(descriptor, requestEpoch = characterCacheEpoch, { manual = false } = {}) {
    const cached = getCachedCharacter(descriptor.key);
    if (!cached?.isSummary || pendingCharacterDetails.has(descriptor.key)) return;
    if (!manual && !characterDetailPolicy(cached).automatic) {
        cached.detailState = 'manual';
        return;
    }
    if (Number(cached.detailRetryAfter) > Date.now()) return;
    cached.detailState = 'loading';
    const request = (async () => {
        await acquireDetailLoadSlot();
        try {
            if (characterCacheEpoch !== requestEpoch) return;
            const chats = await fetchCharacterChats(descriptor.character, descriptor.id);
            if (characterCacheEpoch !== requestEpoch) return;
            const current = getCachedCharacter(descriptor.key);
            if (!current?.isSummary) return;
            if (chats) {
                characterChatCache.set(descriptor.key, {
                    ...descriptor,
                    chats,
                    isSummary: false,
                    detailState: 'ready',
                });
            } else {
                characterChatCache.set(descriptor.key, {
                    ...current,
                    detailState: 'deferred',
                    detailRetryAfter: Date.now() + CHAT_DETAIL_RETRY_MS,
                });
            }
            queueCharacterDetailsRefresh();
        } finally {
            releaseDetailLoadSlot();
        }
    })().catch(error => {
        console.error('[Chats Manager] Failed to enrich chat details for', getCharacterName(descriptor.character), error);
        const current = getCachedCharacter(descriptor.key);
        if (current?.isSummary) {
            characterChatCache.set(descriptor.key, {
                ...current,
                detailState: 'deferred',
                detailRetryAfter: Date.now() + CHAT_DETAIL_RETRY_MS,
            });
            queueCharacterDetailsRefresh();
        }
    });
    pendingCharacterDetails.set(descriptor.key, request);
    void request.finally(() => {
        if (pendingCharacterDetails.get(descriptor.key) === request) {
            pendingCharacterDetails.delete(descriptor.key);
        }
        const current = getCachedCharacter(descriptor.key);
        if (current?.isSummary && Number(current.detailRetryAfter || 0) <= Date.now()) {
            scheduleCharacterDetails({
                id: current.id,
                key: current.key,
                character: current.character,
            }, characterCacheEpoch);
        }
    });
}

async function loadCharacterEntry(descriptor, force = false) {
    const cached = getCachedCharacter(descriptor.key);
    if (cached && !force) {
        if (cached.isSummary) scheduleCharacterDetails(descriptor);
        return { ...cached, id: descriptor.id, character: descriptor.character };
    }
    if (!force && pendingCharacterLoads.has(descriptor.key)) {
        return pendingCharacterLoads.get(descriptor.key);
    }
    const requestEpoch = characterCacheEpoch;
    let request;
    request = (async () => {
        const chats = await fetchCharacterChats(descriptor.character, descriptor.id, { simple: true });
        const entry = {
            ...descriptor,
            chats: chats || [],
            isSummary: true,
            detailState: 'loading',
        };
        if (characterCacheEpoch === requestEpoch && pendingCharacterLoads.get(descriptor.key) === request) {
            characterChatCache.set(descriptor.key, entry);
            scheduleCharacterDetails(descriptor, requestEpoch);
        }
        return entry;
    })();
    pendingCharacterLoads.set(descriptor.key, request);
    try {
        return await request;
    } finally {
        if (pendingCharacterLoads.get(descriptor.key) === request) pendingCharacterLoads.delete(descriptor.key);
    }
}

async function loadCharacterEntries(descriptors, force = false) {
    const unique = [...new Map(descriptors.map(descriptor => [descriptor.key, descriptor])).values()];
    const results = new Array(unique.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < unique.length) {
            const index = nextIndex++;
            results[index] = await loadCharacterEntry(unique[index], force);
        }
    };
    const workerCount = Math.min(CHAT_LOAD_CONCURRENCY, unique.length);
    const workers = Promise.all(Array.from({ length: workerCount }, worker));
    let deadline;
    const indexDeadline = new Promise(resolve => {
        deadline = setTimeout(resolve, CHAT_INDEX_TIMEOUT_MS);
    });
    await Promise.race([workers, indexDeadline]);
    clearTimeout(deadline);
    const completed = results.filter(Boolean);
    if (completed.length < unique.length) {
        console.warn(`[Chats Manager] Chat index deadline reached; showing ${completed.length}/${unique.length} loaded characters.`);
    }
    return completed;
}

function resolveChatAlias(characterKeyValue, value) {
    const aliases = getLibrary(characterKeyValue).chatAliases;
    let resolved = chatName(value);
    const visited = new Set();
    while (aliases[resolved] && !visited.has(resolved)) {
        visited.add(resolved);
        resolved = aliases[resolved];
    }
    return resolved;
}

function buildChatTree(chats) {
    const nodes = new Map(chats.map(chat => [chat.fileName, { chat, children: [], parent: null }]));
    const roots = [];
    for (const node of nodes.values()) {
        const parentName = resolveChatAlias(node.chat.characterKey, node.chat.metadata?.main_chat);
        const parent = parentName && parentName !== node.chat.fileName ? nodes.get(parentName) : null;
        if (parent) {
            node.parent = parent;
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }
    const newestFirst = (a, b) => treeLatestTimestamp(b) - treeLatestTimestamp(a);
    roots.sort(newestFirst);
    for (const node of nodes.values()) node.children.sort(newestFirst);
    return roots;
}

function chatTimestamp(chat) {
    const value = new Date(chat?.lastMessage || 0).getTime();
    return Number.isFinite(value) ? value : 0;
}

function treeLatestTimestamp(node) {
    return Math.max(chatTimestamp(node.chat), ...node.children.map(treeLatestTimestamp));
}

function rootsLatestTimestamp(roots) {
    return roots.length ? Math.max(...roots.map(treeLatestTimestamp)) : 0;
}

function getRootChatName(chat, sourceEntry = null) {
    const entry = sourceEntry || getCachedCharacter(chat.characterKey);
    if (!entry) return chat.fileName;
    const byName = new Map(entry.chats.map(item => [item.fileName, item]));
    let current = chat;
    const visited = new Set();
    while (current && !visited.has(current.fileName)) {
        visited.add(current.fileName);
        const parentName = resolveChatAlias(chat.characterKey, current.metadata?.main_chat);
        const parent = byName.get(parentName);
        if (!parent) break;
        current = parent;
    }
    return current?.fileName || chat.fileName;
}

function getActiveCharacterKey() {
    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId];
    return character && currentChatName() ? characterKey(character) : '';
}

async function validateBackToParentButton() {
    const generation = ++parentButtonValidationGeneration;
    const button = document.getElementById('option_back_to_main');
    if (!button) return;
    button.classList.remove('chm-invalid-parent-chat');
    const parentName = chatName(chat_metadata?.main_chat);
    if (!parentName) return;
    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId];
    if (!character || context.groupId) return;
    try {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar, simple: true }),
        });
        if (!response.ok) return;
        const data = await response.json();
        if (generation !== parentButtonValidationGeneration || !Array.isArray(data)) return;
        const parentExists = data.some(item => chatName(item?.file_name) === parentName);
        button.classList.toggle('chm-invalid-parent-chat', !parentExists);
    } catch (error) {
        console.warn('[Chats Manager] Failed to validate parent chat', error);
    }
}

function treeMatches(node, query) {
    if (!query) return true;
    const haystack = `${getCharacterName(node.chat.character)} ${node.chat.fileName} ${node.chat.message}`.toLocaleLowerCase();
    return haystack.includes(query) || node.children.some(child => treeMatches(child, query));
}

function subtreeCount(node) {
    return node.children.reduce((total, child) => total + 1 + subtreeCount(child), 0);
}

async function openChat(chat) {
    const liveContext = SillyTavern.getContext();
    const liveEntry = Object.entries(liveContext.characters || []).find(([, character]) => characterKey(character) === chat.characterKey);
    if (!liveEntry) {
        toastr.error('找不到这个角色，角色可能已被删除。');
        return;
    }
    const [id] = liveEntry;
    if (String(liveContext.characterId) !== String(id)) {
        await selectCharacterById(id);
        await new Promise(resolve => setTimeout(resolve, 120));
    }
    await openCharacterChat(chat.fileName);
    chatsPanel?.querySelectorAll('.chm-chat-row.is-current').forEach(row => row.classList.remove('is-current'));
    const key = `${chat.characterKey}::${chat.fileName}`;
    chatsPanel?.querySelectorAll('.chm-chat-row').forEach(row => {
        if (row.dataset.chatKey === key) row.classList.add('is-current');
    });
}

async function renameChat(chat) {
    const value = await Popup.show.input('重命名聊天', '输入新的聊天名称', chat.fileName);
    const nextName = String(value ?? '').trim();
    if (!nextName || nextName === chat.fileName) return;
    const liveEntry = Object.entries(SillyTavern.getContext().characters || []).find(([, character]) => characterKey(character) === chat.characterKey);
    if (!liveEntry) return;
    const [id] = liveEntry;
    await renameGroupOrCharacterChat({
        characterId: id,
        groupId: null,
        oldFileName: chat.fileName,
        newFileName: nextName,
        loader: null,
    });
    const library = getLibrary(chat.characterKey);
    if (library.chatFolders[chat.fileName]) {
        library.chatFolders[nextName] = library.chatFolders[chat.fileName];
        delete library.chatFolders[chat.fileName];
    }
    for (const [oldName, alias] of Object.entries(library.chatAliases)) {
        if (alias === chat.fileName) library.chatAliases[oldName] = nextName;
    }
    library.chatAliases[chat.fileName] = nextName;
    const oldPinKey = chatPinKey(chat);
    const pinIndex = settings().pinnedChats.indexOf(oldPinKey);
    if (pinIndex >= 0) settings().pinnedChats[pinIndex] = `${chat.characterKey}::${nextName}`;
    saveSettings();
    invalidateCharacterCache(chat.characterKey);
    await refreshChats();
}

async function createFolder(characterKeyValue) {
    const name = String(await Popup.show.input('新建分组', '给这个分组起一个简短的名字', '') ?? '').trim();
    if (!name) return null;
    const library = getLibrary(characterKeyValue);
    const folder = { id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name };
    library.folders.push(folder);
    saveSettings();
    return folder;
}

async function renameFolder(characterKeyValue, folder) {
    const name = String(await Popup.show.input('重命名分组', '输入新的分组名称', folder.name) ?? '').trim();
    if (!name || name === folder.name) return;
    folder.name = name;
    saveSettings();
    await refreshChats();
}

async function deleteFolder(characterKeyValue, folder) {
    const content = document.createElement('div');
    const question = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = folder.name;
    question.append('删除分组“', strong, '”？');
    const note = document.createElement('p');
    note.className = 'chm-popup-note';
    note.textContent = '聊天不会被删除，只会回到未分组。';
    content.append(question, note);
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: t`Cancel` });
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;
    const library = getLibrary(characterKeyValue);
    library.folders = library.folders.filter(item => item.id !== folder.id);
    for (const [name, folderId] of Object.entries(library.chatFolders)) {
        if (folderId === folder.id) delete library.chatFolders[name];
    }
    saveSettings();
    await refreshChats();
}

async function chooseFolder(chat) {
    const library = getLibrary(chat.characterKey);
    const rootName = getRootChatName(chat);
    const content = document.createElement('div');
    content.className = 'chm-folder-picker';
    const title = document.createElement('h3');
    title.textContent = '移动到分组';
    content.append(title);
    const options = document.createElement('div');
    options.className = 'chm-folder-options';
    const current = library.chatFolders[rootName] || '';
    const choices = [{ id: '', name: '未分组', icon: 'fa-inbox' }, ...library.folders.map(folder => ({ ...folder, icon: 'fa-folder' }))];
    for (const choice of choices) {
        const label = document.createElement('label');
        label.className = 'chm-folder-option';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'chm-folder';
        radio.value = choice.id;
        radio.checked = current === choice.id;
        const icon = document.createElement('i');
        icon.className = `fa-regular ${choice.icon}`;
        const text = document.createElement('span');
        text.textContent = choice.name;
        label.append(radio, icon, text);
        options.append(label);
    }
    content.append(options);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'menu_button chm-picker-add';
    add.innerHTML = '<i class="fa-solid fa-plus"></i> 新建分组';
    add.addEventListener('click', async () => {
        const folder = await createFolder(chat.characterKey);
        if (!folder) return;
        const label = document.createElement('label');
        label.className = 'chm-folder-option';
        label.innerHTML = `<input type="radio" name="chm-folder" value="${folder.id}"><i class="fa-regular fa-folder"></i><span></span>`;
        label.querySelector('span').textContent = folder.name;
        options.append(label);
        label.querySelector('input').checked = true;
    });
    content.append(add);
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '移动', cancelButton: t`Cancel` });
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;
    const selected = content.querySelector('input[name="chm-folder"]:checked')?.value || '';
    if (selected) library.chatFolders[rootName] = selected;
    else delete library.chatFolders[rootName];
    saveSettings();
    await refreshChats();
}

async function exportChats(chats, format) {
    if (!chats.length) return;
    chatsBatchBusy = true;
    updateChatsBatchUi();
    let exported = 0;
    try {
        await SillyTavern.getContext().saveChat?.();
        for (const chat of chats) {
            const fileName = `${chat.fileName}.${format}`;
            const response = await fetch('/api/chats/export', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    is_group: false,
                    avatar_url: chat.character.avatar,
                    file: `${chat.fileName}.jsonl`,
                    exportfilename: fileName,
                    format,
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.message || `无法导出 ${chat.fileName}`);
            const downloadName = chats.length > 1 ? `${getCharacterName(chat.character)} - ${fileName}` : fileName;
            download(data.result, downloadName, format === 'txt' ? 'text/plain' : 'application/octet-stream');
            exported++;
        }
        toastr.success(`已导出 ${exported} 个聊天文件`);
    } catch (error) {
        console.error('[Chats Manager] Export failed', error);
        toastr.error(`导出中断：${error.message}`);
    } finally {
        chatsBatchBusy = false;
        updateChatsBatchUi();
    }
}

function removeChatReferences(chat) {
    const library = getLibrary(chat.characterKey);
    delete library.chatFolders[chat.fileName];
    delete library.chatAliases[chat.fileName];
    for (const [oldName, currentName] of Object.entries(library.chatAliases)) {
        if (currentName === chat.fileName) delete library.chatAliases[oldName];
    }
    settings().pinnedChats = settings().pinnedChats.filter(key => key !== chatPinKey(chat));
    chatsSelectedChats.delete(chatPinKey(chat));
}

async function deleteChats(chats) {
    const unique = [...new Map(chats.map(chat => [chatPinKey(chat), chat])).values()];
    if (!unique.length) return;
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = unique.length === 1 ? `删除“${unique[0].fileName}”？` : `删除选中的 ${unique.length} 个聊天？`;
    const warning = document.createElement('p');
    warning.className = 'chm-popup-note';
    warning.textContent = '聊天文件会被永久删除，此操作无法撤销。若删除父聊天，已有分支聊天不会自动删除。';
    content.append(title, warning);
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: t`Cancel` });
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;
    chatsBatchBusy = true;
    updateChatsBatchUi();
    const invalidated = new Set();
    try {
        await SillyTavern.getContext().saveChat?.();
        for (const chat of unique) {
            const liveEntry = Object.entries(SillyTavern.getContext().characters || [])
                .find(([, character]) => characterKey(character) === chat.characterKey);
            if (!liveEntry) continue;
            await deleteCharacterChatByName(String(liveEntry[0]), chat.fileName);
            removeChatReferences(chat);
            invalidated.add(chat.characterKey);
        }
        invalidated.forEach(invalidateCharacterCache);
        saveSettings();
        toastr.success(`已删除 ${unique.length} 个聊天`);
        await refreshChats();
        scheduleNativeChatGrouping();
    } catch (error) {
        console.error('[Chats Manager] Delete failed', error);
        toastr.error(`删除中断：${error.message}`);
    } finally {
        chatsBatchBusy = false;
        updateChatsBatchUi();
    }
}

async function chooseTargetCharacter(title) {
    const descriptors = getCharacterDescriptors().sort((a, b) => getCharacterName(a.character).localeCompare(getCharacterName(b.character)));
    if (!descriptors.length) return null;
    const focusedKey = chatsPanel?.dataset.focusCharacterKey || '';
    if (focusedKey) return descriptors.find(item => item.key === focusedKey) || null;
    const content = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const select = document.createElement('select');
    select.className = 'text_pole wide100p';
    const activeKey = getActiveCharacterKey();
    for (const descriptor of descriptors) {
        const option = document.createElement('option');
        option.value = descriptor.key;
        option.textContent = getCharacterName(descriptor.character);
        option.selected = descriptor.key === activeKey;
        select.append(option);
    }
    content.append(heading, select);
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '继续', cancelButton: t`Cancel` });
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return null;
    return descriptors.find(item => item.key === select.value) || null;
}

async function importChatsToCharacter() {
    const target = await chooseTargetCharacter('选择聊天导入到哪个角色');
    if (!target) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.jsonl';
    input.multiple = true;
    input.hidden = true;
    document.body.append(input);
    const removeCancelledPicker = () => {
        setTimeout(() => {
            if (!input.files?.length) input.remove();
        }, 250);
    };
    window.addEventListener('focus', removeCancelledPicker, { once: true });
    input.addEventListener('change', async () => {
        let imported = 0;
        try {
            for (const file of input.files || []) {
                const format = file.name.match(/\.(jsonl?)$/i)?.[1]?.toLowerCase();
                if (!format) {
                    toastr.warning(`不支持的文件：${file.name}`);
                    continue;
                }
                const formData = new FormData();
                formData.set('file_type', format);
                formData.set('avatar', file);
                formData.set('avatar_url', target.character.avatar);
                formData.set('user_name', SillyTavern.getContext().name1 || 'User');
                formData.set('character_name', getCharacterName(target.character));
                const result = await importCharacterChat(formData, { refresh: false });
                imported += result.length;
            }
            if (imported) {
                invalidateCharacterCache(target.key);
                toastr.success(`已向 ${getCharacterName(target.character)} 导入 ${imported} 个聊天`);
                await refreshChats();
                scheduleNativeChatGrouping();
            } else if (input.files?.length) {
                toastr.warning('没有导入聊天，请确认文件格式和内容是否有效。');
            }
        } catch (error) {
            console.error('[Chats Manager] Import failed', error);
            toastr.error(`导入失败：${error.message}`);
        } finally {
            input.remove();
        }
    }, { once: true });
    input.click();
}

function parseBackupName(name) {
    const match = String(name).match(/^chat_(.+)_(\d{8})-(\d{6})\.jsonl$/i);
    if (!match) return { source: '其他备份', timestamp: 0 };
    const [, source, date, time] = match;
    const timestamp = new Date(
        Number(date.slice(0, 4)),
        Number(date.slice(4, 6)) - 1,
        Number(date.slice(6, 8)),
        Number(time.slice(0, 2)),
        Number(time.slice(2, 4)),
        Number(time.slice(4, 6)),
    ).getTime();
    return { source, timestamp };
}

function backupSourceLabel(source) {
    const normalized = String(source).toLowerCase();
    const descriptor = getCharacterDescriptors().find(item => {
        const avatar = String(item.character.avatar || '').replace(/\.[^.]+$/i, '').replace(/[^a-z0-9]/gi, '_').toLowerCase();
        return avatar === normalized;
    });
    return descriptor ? getCharacterName(descriptor.character) : source;
}

async function fetchBackupFile(name) {
    const response = await fetch('/api/backups/chat/download', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error(`无法读取备份 ${name}`);
    return response;
}

async function downloadBackup(name) {
    try {
        const response = await fetchBackupFile(name);
        const blob = await response.blob();
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    } catch (error) {
        console.error('[Chats Manager] Backup download failed', error);
        toastr.error(error.message);
    }
}

async function fetchBackupTextRange(name, range, maxBytes) {
    const headers = getRequestHeaders();
    if (range) headers.Range = range;
    const response = await fetch('/api/backups/chat/download', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error(`无法读取备份 ${name}（HTTP ${response.status}）`);
    if (!response.body) return { text: '', partial: false, complete: true };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    let complete = false;
    try {
        while (bytes < maxBytes) {
            const { done, value } = await reader.read();
            if (done) {
                complete = true;
                break;
            }
            const remaining = maxBytes - bytes;
            text += decoder.decode(value.subarray(0, remaining), { stream: true });
            bytes += Math.min(value.byteLength, remaining);
            if (value.byteLength >= remaining) break;
        }
        text += decoder.decode();
    } finally {
        await reader.cancel().catch(() => {});
    }
    return { text, partial: response.status === 206, complete };
}

function parsePreviewLines(text, { dropFirst = false } = {}) {
    const lines = text.split('\n');
    if (dropFirst) lines.shift();
    return lines.flatMap(line => {
        try {
            const item = JSON.parse(line);
            return item?.mes ? [item] : [];
        } catch {
            return [];
        }
    });
}

async function readBackupPreview(name) {
    const [headResult, tailResult] = await Promise.allSettled([
        fetchBackupTextRange(name, `bytes=0-${BACKUP_PREVIEW_HEAD_BYTES - 1}`, BACKUP_PREVIEW_HEAD_BYTES),
        fetchBackupTextRange(name, `bytes=-${BACKUP_PREVIEW_TAIL_BYTES}`, BACKUP_PREVIEW_TAIL_BYTES),
    ]);
    // Some SillyTavern versions or reverse proxies reject byte ranges on POST downloads.
    // Fall back to a capped normal read so one failed tail request never blocks the preview.
    const head = headResult.status === 'fulfilled'
        ? headResult.value
        : await fetchBackupTextRange(name, '', BACKUP_PREVIEW_HEAD_BYTES);
    const first = parsePreviewLines(head.text).slice(0, BACKUP_PREVIEW_SIDE_MAX);
    let last = [];
    let tailAvailable = false;
    if (tailResult.status === 'fulfilled') {
        const tail = tailResult.value;
        tailAvailable = tail.partial || tail.complete;
        if (tailAvailable) {
            last = (tail.partial ? parsePreviewLines(tail.text, { dropFirst: true }) : parsePreviewLines(tail.text)).slice(-BACKUP_PREVIEW_SIDE_MAX);
        }
    } else if (head.complete) {
        tailAvailable = true;
        last = parsePreviewLines(head.text).slice(-BACKUP_PREVIEW_SIDE_MAX);
    } else {
        console.warn('[Chats Manager] Backup tail preview unavailable', name, tailResult.reason);
    }
    return { first, last, tailAvailable };
}

async function viewBackup(backupOrName) {
    const backup = typeof backupOrName === 'string' ? { file_name: backupOrName } : backupOrName;
    const name = backup.file_name;
    try {
        const { first, last, tailAvailable } = await readBackupPreview(name);
        const content = document.createElement('div');
        content.className = 'chm-backup-preview';
        const heading = document.createElement('div');
        heading.className = 'chm-backup-preview-heading';
        const identity = document.createElement('div');
        identity.className = 'chm-backup-preview-identity';
        const title = document.createElement('strong');
        title.textContent = '备份内容预览';
        const note = document.createElement('span');
        note.textContent = `${formatDate(backup.last_mes || parseBackupName(name).timestamp)} · ${backup.chat_items ?? '?'} 条消息`;
        identity.append(title, note);
        const controls = document.createElement('div');
        controls.className = 'chm-backup-preview-controls';
        const makeCountSelect = (label, value = '5') => {
            const wrapper = document.createElement('label');
            wrapper.append(`${label} `);
            const select = document.createElement('select');
            select.className = 'text_pole';
            for (const count of [3, 5, 10, 20]) select.add(new Option(`${count} 楼`, String(count)));
            select.value = value;
            wrapper.append(select);
            return { wrapper, select };
        };
        const headCount = makeCountSelect('开头');
        const tailCount = makeCountSelect('结尾');
        controls.append(headCount.wrapper, tailCount.wrapper);
        heading.append(identity, controls);
        const body = document.createElement('div');
        body.className = 'chm-backup-preview-body';
        const renderMessages = () => {
            const startItems = first.slice(0, Number(headCount.select.value));
            const endItems = last.slice(-Number(tailCount.select.value));
            const seen = new Set(startItems.map(item => `${item.send_date || ''}\u0000${item.name || ''}\u0000${item.mes}`));
            const uniqueEnd = endItems.filter(item => !seen.has(`${item.send_date || ''}\u0000${item.name || ''}\u0000${item.mes}`));
            body.replaceChildren();
            const appendMessage = (item, indexLabel) => {
                const article = document.createElement('article');
                article.className = 'chm-backup-preview-message';
                const meta = document.createElement('header');
                const speaker = document.createElement('strong');
                speaker.textContent = item.name || '未知发言者';
                const floor = document.createElement('span');
                floor.textContent = `${indexLabel} · ${formatDate(item.send_date)}`;
                meta.append(speaker, floor);
                const message = document.createElement('div');
                message.className = 'chm-backup-preview-message-text';
                message.textContent = item.mes;
                article.append(meta, message);
                body.append(article);
            };
            startItems.forEach((item, index) => appendMessage(item, `前 ${index + 1}`));
            if (uniqueEnd.length || !tailAvailable) {
                const gap = document.createElement('div');
                gap.className = 'chm-backup-preview-gap';
                gap.innerHTML = tailAvailable
                    ? '<i class="fa-solid fa-ellipsis"></i><span>中间内容未加载</span>'
                    : '<i class="fa-solid fa-triangle-exclamation"></i><span>服务器未提供文件尾分段读取</span>';
                body.append(gap);
                uniqueEnd.forEach((item, index) => appendMessage(item, `后 ${uniqueEnd.length - index}`));
            }
            if (!startItems.length && !uniqueEnd.length) {
                const empty = document.createElement('div');
                empty.className = 'chm-backups-empty';
                empty.textContent = '没有可预览的消息';
                body.append(empty);
            }
        };
        headCount.select.addEventListener('change', renderMessages);
        tailCount.select.addEventListener('change', renderMessages);
        renderMessages();
        content.append(heading, body);
        const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', { wide: true });
        await popup.show();
    } catch (error) {
        console.error('[Chats Manager] Backup preview failed', error);
        toastr.error(error.message);
    }
}

async function restoreBackup(name, source, presetTarget = null) {
    const descriptors = getCharacterDescriptors().sort((a, b) => getCharacterName(a.character).localeCompare(getCharacterName(b.character)));
    if (!descriptors.length) return toastr.error('没有可用于恢复备份的角色。');
    let target = presetTarget ? descriptors.find(item => item.key === presetTarget.key) : null;
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = '恢复备份为新聊天';
    const note = document.createElement('p');
    note.className = 'chm-popup-note';
    note.textContent = target
        ? `将恢复到“${getCharacterName(target.character)}”的聊天列表，并生成一份新聊天；当前聊天不会被覆盖。`
        : '恢复会导入一份新聊天，不会覆盖当前聊天。请确认目标角色。';
    content.append(title, note);
    let select = null;
    if (!target) {
        select = document.createElement('select');
        select.className = 'text_pole wide100p';
        const normalized = String(source).toLowerCase();
        for (const descriptor of descriptors) {
            const option = document.createElement('option');
            option.value = descriptor.key;
            option.textContent = getCharacterName(descriptor.character);
            const avatar = String(descriptor.character.avatar || '').replace(/\.[^.]+$/i, '').replace(/[^a-z0-9]/gi, '_').toLowerCase();
            option.selected = avatar === normalized;
            select.append(option);
        }
        content.append(select);
    }
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '恢复', cancelButton: t`Cancel` });
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;
    if (!target) target = descriptors.find(item => item.key === select?.value);
    if (!target) return;
    try {
        const response = await fetchBackupFile(name);
        const file = new File([await response.blob()], name, { type: 'application/octet-stream' });
        const formData = new FormData();
        formData.set('file_type', 'jsonl');
        formData.set('avatar', file);
        formData.set('avatar_url', target.character.avatar);
        formData.set('user_name', SillyTavern.getContext().name1 || 'User');
        formData.set('character_name', getCharacterName(target.character));
        const result = await importCharacterChat(formData, { refresh: false });
        if (!result.length) throw new Error('酒馆没有返回已恢复的聊天文件');
        invalidateCharacterCache(target.key);
        if (chatsPanel && !chatsPanel.hidden) await refreshChats();
        toastr.success(`已恢复到 ${getCharacterName(target.character)}：${result.join('、')}`);
    } catch (error) {
        console.error('[Chats Manager] Backup restore failed', error);
        toastr.error(`恢复失败：${error.message}`);
    }
}

async function deleteBackups(names, { confirm = true } = {}) {
    if (!names.length) return [];
    if (confirm) {
        const content = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = names.length === 1 ? '删除这个聊天备份？' : `删除选中的 ${names.length} 个聊天备份？`;
        const note = document.createElement('p');
        note.className = 'chm-popup-note';
        note.textContent = '备份文件会被永久删除，此操作无法撤销。原聊天不会受到影响。';
        content.append(title, note);
        const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: t`Cancel` });
        if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return [];
    }
    const deleted = [];
    for (const name of names) {
        try {
            const response = await fetch('/api/backups/chat/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name }),
            });
            if (response.ok) deleted.push(name);
        } catch (error) {
            console.error('[Chats Manager] Backup delete failed', name, error);
        }
    }
    if (deleted.length) toastr.success(`已删除 ${deleted.length} 个聊天备份`);
    if (deleted.length !== names.length) toastr.warning(`${names.length - deleted.length} 个备份删除失败`);
    return deleted;
}

async function downloadBackupsAsZip(backups) {
    if (!backups.length) return;
    const totalBytes = backups.reduce((sum, backup) => sum + parseBackupSize(backup.file_size), 0);
    if (totalBytes > 256 * 1024 * 1024) {
        toastr.warning('所选备份超过 256 MiB。为避免浏览器内存溢出，请分批选择，或逐个下载原始文件。');
        return;
    }
    try {
        if (!globalThis.JSZip) await import('../../../../lib/jszip.min.js');
        if (!globalThis.JSZip) throw new Error('ZIP 组件不可用');
        const zip = new globalThis.JSZip();
        let completed = 0;
        for (const backup of backups) {
            const response = await fetchBackupFile(backup.file_name);
            zip.file(backup.file_name, await response.blob());
            completed++;
            toastr.info(`正在准备备份压缩包：${completed}/${backups.length}`, '', { timeOut: 800, preventDuplicates: true });
        }
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = `chat-backups-${new Date().toISOString().slice(0, 10)}.zip`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    } catch (error) {
        console.error('[Chats Manager] Backup ZIP failed', error);
        toastr.error(`批量下载失败：${error.message}`);
    }
}

function parseBackupSize(value) {
    const match = String(value || '').trim().match(/^([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB)?$/i);
    if (!match) return 0;
    const unit = (match[2] || 'B').toUpperCase();
    const factor = unit.startsWith('G') ? 1024 ** 3 : unit.startsWith('M') ? 1024 ** 2 : unit.startsWith('K') ? 1024 : 1;
    return Number(match[1]) * factor;
}

async function openBackupManager() {
    const content = document.createElement('div');
    content.className = 'chm-backup-manager';
    content.innerHTML = `
        <div class="chm-backup-heading">
            <div><h3>聊天备份</h3><p>查看酒馆自动生成的聊天快照。只有打开这里时才会读取备份目录。</p></div>
            <span class="chm-backup-status" aria-live="polite"></span>
        </div>
        <div class="chm-backup-toolbar">
            <label class="chm-search chm-backup-search"><i class="fa-solid fa-magnifying-glass"></i><input class="text_pole" type="search" placeholder="搜索来源或文件名…" aria-label="搜索聊天备份"></label>
            <select class="text_pole chm-backup-source" aria-label="筛选备份来源"><option value="">全部来源</option></select>
            <button type="button" class="chm-icon-button chm-backup-refresh" title="刷新备份列表" aria-label="刷新备份列表"><i class="fa-solid fa-rotate"></i></button>
        </div>
        <div class="chm-backup-batch">
            <label class="checkbox_label"><input type="checkbox" class="chm-backup-select-page"><span>本页全选</span></label>
            <span class="chm-backup-selected">已选 0</span>
            <button type="button" class="menu_button chm-backup-zip" disabled><i class="fa-solid fa-file-zipper"></i><span>打包下载</span></button>
            <button type="button" class="menu_button chm-backup-delete-selected" disabled><i class="fa-regular fa-trash-can"></i><span>删除</span></button>
        </div>
        <div class="chm-backup-list" aria-live="polite"></div>
        <div class="chm-backup-pagination"></div>`;

    const status = content.querySelector('.chm-backup-status');
    const search = content.querySelector('.chm-backup-search input');
    const sourceSelect = content.querySelector('.chm-backup-source');
    const selectPage = content.querySelector('.chm-backup-select-page');
    const selectedLabel = content.querySelector('.chm-backup-selected');
    const zipButton = content.querySelector('.chm-backup-zip');
    const deleteButton = content.querySelector('.chm-backup-delete-selected');
    const list = content.querySelector('.chm-backup-list');
    const pagination = content.querySelector('.chm-backup-pagination');
    const selected = new Set();
    let backups = [];
    let page = 1;
    let loading = false;
    const controller = new AbortController();

    const filteredBackups = () => {
        const term = search.value.trim().toLowerCase();
        return backups.filter(backup => {
            const parsed = parseBackupName(backup.file_name);
            const source = backupSourceLabel(parsed.source);
            return (!sourceSelect.value || parsed.source === sourceSelect.value)
                && (!term || backup.file_name.toLowerCase().includes(term) || source.toLowerCase().includes(term));
        });
    };

    const updateBatch = pageItems => {
        const selectedItems = backups.filter(item => selected.has(item.file_name));
        selectedLabel.textContent = `已选 ${selectedItems.length}`;
        zipButton.disabled = deleteButton.disabled = selectedItems.length === 0 || loading;
        selectPage.disabled = pageItems.length === 0 || loading;
        selectPage.checked = pageItems.length > 0 && pageItems.every(item => selected.has(item.file_name));
        selectPage.indeterminate = !selectPage.checked && pageItems.some(item => selected.has(item.file_name));
    };

    const render = () => {
        const filtered = filteredBackups();
        const pageCount = Math.max(1, Math.ceil(filtered.length / BACKUP_PAGE_SIZE));
        page = Math.min(page, pageCount);
        const pageItems = filtered.slice((page - 1) * BACKUP_PAGE_SIZE, page * BACKUP_PAGE_SIZE);
        list.replaceChildren();
        if (!pageItems.length) {
            const empty = document.createElement('div');
            empty.className = 'chm-empty-state';
            empty.textContent = loading ? '正在整理备份…' : backups.length ? '没有符合条件的备份' : '没有找到聊天备份';
            list.append(empty);
        }
        for (const backup of pageItems) {
            const parsed = parseBackupName(backup.file_name);
            const row = document.createElement('div');
            row.className = 'chm-backup-row';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selected.has(backup.file_name);
            checkbox.setAttribute('aria-label', `选择 ${backup.file_name}`);
            checkbox.addEventListener('change', () => {
                checkbox.checked ? selected.add(backup.file_name) : selected.delete(backup.file_name);
                updateBatch(pageItems);
            });
            const main = document.createElement('div');
            main.className = 'chm-backup-main';
            const name = document.createElement('strong');
            name.className = 'chm-backup-name';
            name.textContent = backupSourceLabel(parsed.source);
            name.title = backup.file_name;
            const meta = document.createElement('span');
            meta.className = 'chm-backup-meta';
            meta.textContent = `${formatDate(backup.last_mes || parsed.timestamp)} · ${backup.file_size || '未知大小'} · ${backup.chat_items ?? '?'} 条消息`;
            main.append(name, meta);
            const actions = document.createElement('div');
            actions.className = 'chm-backup-actions';
            const action = (icon, title, handler, danger = false) => {
                const button = iconButton(icon, title, danger ? 'chm-backup-danger' : '');
                button.addEventListener('click', handler);
                return button;
            };
            actions.append(
                action('fa-regular fa-eye', '查看有限预览', () => viewBackup(backup.file_name)),
                action('fa-solid fa-download', '下载原始备份', () => downloadBackup(backup.file_name)),
                action('fa-solid fa-rotate-left', '恢复为新聊天', () => restoreBackup(backup.file_name, parsed.source)),
                action('fa-regular fa-trash-can', '删除备份', async () => {
                    const deleted = await deleteBackups([backup.file_name]);
                    if (deleted.length) {
                        backups = backups.filter(item => !deleted.includes(item.file_name));
                        for (const name of deleted) selected.delete(name);
                        render();
                    }
                }, true),
            );
            row.append(checkbox, main, actions);
            list.append(row);
        }
        status.textContent = loading ? '读取中…' : `${filtered.length} 个备份`;
        pagination.replaceChildren();
        const previous = iconButton('fa-solid fa-chevron-left', '上一页', 'chm-backup-page-button');
        const next = iconButton('fa-solid fa-chevron-right', '下一页', 'chm-backup-page-button');
        previous.disabled = page <= 1;
        next.disabled = page >= pageCount;
        previous.addEventListener('click', () => { page--; render(); });
        next.addEventListener('click', () => { page++; render(); });
        const pageLabel = document.createElement('span');
        pageLabel.textContent = `${page} / ${pageCount}`;
        pagination.append(previous, pageLabel, next);
        updateBatch(pageItems);
    };

    const load = async () => {
        if (loading) return;
        loading = true;
        render();
        try {
            const response = await fetch('/api/backups/chat/get', { method: 'POST', headers: getRequestHeaders(), signal: controller.signal });
            if (!response.ok) throw new Error('无法读取聊天备份列表');
            backups = await response.json();
            backups.sort((a, b) => (parseBackupName(b.file_name).timestamp || Date.parse(b.last_mes) || 0) - (parseBackupName(a.file_name).timestamp || Date.parse(a.last_mes) || 0));
            selected.clear();
            sourceSelect.replaceChildren(new Option('全部来源', ''));
            const sources = [...new Set(backups.map(item => parseBackupName(item.file_name).source))]
                .sort((a, b) => backupSourceLabel(a).localeCompare(backupSourceLabel(b)));
            for (const source of sources) sourceSelect.add(new Option(backupSourceLabel(source), source));
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('[Chats Manager] Backup list failed', error);
                toastr.error(error.message);
            }
        } finally {
            loading = false;
            render();
        }
    };

    search.addEventListener('input', () => { page = 1; render(); });
    sourceSelect.addEventListener('change', () => { page = 1; render(); });
    content.querySelector('.chm-backup-refresh').addEventListener('click', load);
    selectPage.addEventListener('change', () => {
        const filtered = filteredBackups();
        const pageItems = filtered.slice((page - 1) * BACKUP_PAGE_SIZE, page * BACKUP_PAGE_SIZE);
        for (const item of pageItems) selectPage.checked ? selected.add(item.file_name) : selected.delete(item.file_name);
        render();
    });
    zipButton.addEventListener('click', () => downloadBackupsAsZip(backups.filter(item => selected.has(item.file_name))));
    deleteButton.addEventListener('click', async () => {
        const names = [...selected];
        const deletedNames = await deleteBackups(names);
        if (deletedNames.length) {
            const deleted = new Set(deletedNames);
            backups = backups.filter(item => !deleted.has(item.file_name));
            for (const name of deleted) selected.delete(name);
            render();
        }
    });

    render();
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', { large: true, wide: true });
    const shown = popup.show();
    void load();
    await shown;
    controller.abort();
}

async function readBackupIdentity(backup, signal) {
    const response = await fetch('/api/backups/chat/download', {
        method: 'POST',
        headers: { ...getRequestHeaders(), Range: `bytes=0-${BACKUP_IDENTITY_MAX_BYTES - 1}` },
        body: JSON.stringify({ name: backup.file_name }),
        signal,
    });
    if (!response.ok) throw new Error(`无法识别备份 ${backup.file_name}`);
    const reader = response.body?.getReader();
    if (!reader) return { identity: '', chatHash: '' };
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
        while (bytes < BACKUP_IDENTITY_MAX_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = BACKUP_IDENTITY_MAX_BYTES - bytes;
            text += decoder.decode(value.subarray(0, remaining), { stream: true });
            bytes += Math.min(value.byteLength, remaining);
            if (value.byteLength >= remaining) break;
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    const integrity = text.match(/"integrity"\s*:\s*"([^"\\]+)"/)?.[1];
    const hashMatch = text.match(/"chat_id_hash"\s*:\s*(?:"([^"\\]+)"|(\d+))/);
    const chatHash = hashMatch?.[1] || hashMatch?.[2] || '';
    return { identity: integrity || chatHash, chatHash };
}

async function identifyBackups(backups, signal, onProgress) {
    let nextIndex = 0;
    let completed = 0;
    const worker = async () => {
        while (nextIndex < backups.length) {
            const index = nextIndex++;
            const backup = backups[index];
            try {
                const identity = await readBackupIdentity(backup, signal);
                backup.chatIdentity = identity.identity;
                backup.chatHash = identity.chatHash;
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                console.warn('[Chats Manager] Backup identity unavailable', backup.file_name, error);
                backup.chatIdentity = '';
            }
            completed++;
            onProgress?.(completed, backups.length);
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, backups.length) }, worker));
    return backups;
}

function groupBackupsByChat(backups) {
    const groups = new Map();
    for (const backup of backups) {
        const parsed = parseBackupName(backup.file_name);
        const identity = backup.chatIdentity || backup.file_name;
        const key = `${parsed.source}::${identity}`;
        if (!groups.has(key)) groups.set(key, { key, source: parsed.source, identity, backups: [] });
        groups.get(key).backups.push(backup);
    }
    return [...groups.values()].map(group => {
        group.backups.sort((a, b) => parseBackupName(b.file_name).timestamp - parseBackupName(a.file_name).timestamp);
        group.latest = group.backups[0];
        group.chatHash = group.backups.find(backup => backup.chatHash)?.chatHash || '';
        group.timestamp = parseBackupName(group.latest.file_name).timestamp;
        group.totalBytes = group.backups.reduce((sum, backup) => sum + parseBackupSize(backup.file_size), 0);
        return group;
    }).sort((a, b) => b.timestamp - a.timestamp);
}

function closeChatBackups() {
    const view = chatsPanel?.querySelector('.chm-chat-backups-view');
    if (!view) return;
    view._chmDispose?.();
    view.remove();
    chatsPanel.classList.remove('is-backup-detail');
    for (const child of chatsPanel.children) {
        child.hidden = child.dataset.backupWasHidden === 'true';
        delete child.dataset.backupWasHidden;
    }
    refreshBackups = null;
    chatsPanel.scrollTop = 0;
}

function openChatBackups(chat) {
    closeChatBackups();
    for (const child of chatsPanel.children) {
        child.dataset.backupWasHidden = String(child.hidden);
        child.hidden = true;
    }
    chatsPanel.classList.add('is-backup-detail');
    const view = makeBackupsPanel(chat);
    chatsPanel.append(view);
    chatsPanel.scrollTop = 0;
    void refreshBackups?.(true);
}

function makeBackupsPanel(targetChat) {
    const wrapper = document.createElement('div');
    wrapper.className = 'chm-chat-backups-view';
    wrapper.innerHTML = `
        <div class="chm-backups-sticky">
            <div class="chm-toolbar chm-backups-toolbar">
                <button type="button" class="chm-icon-button chm-backups-back" title="返回聊天列表" aria-label="返回聊天列表"><i class="fa-solid fa-arrow-left"></i></button>
                <div class="chm-backups-title"><strong></strong><span class="chm-backups-count">历史备份</span></div>
                <button type="button" class="chm-icon-button chm-backups-batch-toggle" title="批量管理这条聊天的备份" aria-label="批量管理这条聊天的备份"><i class="fa-solid fa-pen-to-square"></i></button>
                <button type="button" class="chm-icon-button chm-backups-refresh" title="刷新这条聊天的备份" aria-label="刷新这条聊天的备份"><i class="fa-solid fa-rotate"></i></button>
            </div>
            <div class="chm-backups-tools">
                <label class="chm-search"><i class="fa-solid fa-magnifying-glass"></i><input class="text_pole chm-backups-search" type="search" placeholder="搜索时间、文件名或末条内容…" aria-label="搜索这条聊天的备份"></label>
                <div class="chm-pagination chm-backups-pagination"></div>
            </div>
        </div>
        <div class="chm-batch-bar chm-backups-batchbar" hidden>
            <button type="button" class="chm-menu-action chm-backups-select-page"><i class="fa-solid fa-check-double"></i><span>全选本页</span></button>
            <span class="chm-batch-count chm-backups-selected">已选 0</span>
            <button type="button" class="chm-menu-action chm-backups-download-selected" disabled><i class="fa-solid fa-file-zipper"></i><span>打包下载</span></button>
            <button type="button" class="chm-menu-action chm-menu-danger chm-backups-delete-selected" disabled><i class="fa-regular fa-trash-can"></i><span>删除</span></button>
            <button type="button" class="chm-menu-action chm-backups-exit-batch"><i class="fa-solid fa-xmark"></i><span>退出</span></button>
        </div>
        <div class="chm-backups-list"></div>`;

    wrapper.querySelector('.chm-backups-title strong').textContent = targetChat.fileName;
    const search = wrapper.querySelector('.chm-backups-search');
    const count = wrapper.querySelector('.chm-backups-count');
    const batchbar = wrapper.querySelector('.chm-backups-batchbar');
    const selectedLabel = wrapper.querySelector('.chm-backups-selected');
    const downloadSelected = wrapper.querySelector('.chm-backups-download-selected');
    const deleteSelected = wrapper.querySelector('.chm-backups-delete-selected');
    const list = wrapper.querySelector('.chm-backups-list');
    const pagination = wrapper.querySelector('.chm-backups-pagination');
    const selected = new Set();
    let groups = [];
    let page = 1;
    let pageSize = BACKUP_HISTORY_DEFAULT_PAGE_SIZE;
    let batchMode = false;
    let loaded = false;
    let loading = false;
    let loadController = null;
    wrapper._chmDispose = () => loadController?.abort();

    const allBackups = () => groups.flatMap(group => group.backups)
        .sort((a, b) => parseBackupName(b.file_name).timestamp - parseBackupName(a.file_name).timestamp);
    const visibleBackups = () => {
        const query = search.value.trim().toLocaleLowerCase();
        if (!query) return allBackups();
        return allBackups().filter(backup => {
            const parsed = parseBackupName(backup.file_name);
            const haystack = `${backup.file_name} ${formatDate(parsed.timestamp)} ${formatDate(backup.last_mes)} ${backup.mes || ''}`.toLocaleLowerCase();
            return haystack.includes(query);
        });
    };

    const updateBatchbar = pageBackups => {
        batchbar.hidden = !batchMode;
        wrapper.classList.toggle('is-batch-mode', batchMode);
        selectedLabel.textContent = `已选 ${selected.size}`;
        downloadSelected.disabled = deleteSelected.disabled = !selected.size || loading;
        wrapper.querySelector('.chm-backups-select-page').disabled = !pageBackups.length || loading;
    };

    const render = () => {
        const filtered = visibleBackups();
        const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
        page = Math.min(page, pageCount);
        const pageBackups = filtered.slice((page - 1) * pageSize, page * pageSize);
        list.replaceChildren();
        if (!pageBackups.length) {
            const empty = document.createElement('div');
            empty.className = 'chm-backups-empty';
            empty.innerHTML = loading
                ? '<i class="fa-solid fa-spinner fa-spin"></i><span>正在整理聊天备份…</span>'
                : `<i class="fa-regular fa-clock"></i><span>${loaded ? (allBackups().length ? '没有匹配的备份' : '没有找到这个聊天的备份') : '进入后才会读取这条聊天的备份'}</span>`;
            list.append(empty);
        }
        for (const backup of pageBackups) {
            const parsed = parseBackupName(backup.file_name);
            const row = document.createElement('div');
            row.className = 'chm-backup-history-row';
            if (batchMode) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'chm-backup-history-select';
                checkbox.checked = selected.has(backup.file_name);
                checkbox.setAttribute('aria-label', `选择 ${backup.file_name}`);
                checkbox.addEventListener('change', () => {
                    checkbox.checked ? selected.add(backup.file_name) : selected.delete(backup.file_name);
                    updateBatchbar(pageBackups);
                });
                row.append(checkbox);
            }
            const icon = document.createElement('span');
            icon.className = 'chm-backup-history-icon';
            icon.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i>';
            const main = document.createElement('div');
            main.className = 'chm-backup-history-main';
            const headline = document.createElement('div');
            headline.className = 'chm-backup-history-headline';
            const date = document.createElement('strong');
            date.textContent = formatDate(parsed.timestamp);
            const meta = document.createElement('span');
            meta.textContent = `${backup.file_size || '未知大小'} · ${backup.chat_items ?? '?'} 条消息`;
            headline.append(date, meta);
            const preview = document.createElement('span');
            preview.className = 'chm-backup-history-preview';
            preview.textContent = chatPreview(backup.mes, 110) || '这个备份没有末条消息预览';
            preview.title = String(backup.mes || '').replace(/\s+/g, ' ').trim();
            main.append(headline, preview);
            const actions = document.createElement('span');
            actions.className = 'chm-backup-history-actions';
            const action = (iconName, label, handler, className = '') => {
                const button = iconButton(iconName, label, className);
                button.addEventListener('click', handler);
                return button;
            };
            actions.append(
                action('fa-regular fa-eye', '预览开头和结尾', () => viewBackup(backup)),
                action('fa-solid fa-download', '下载原始备份', () => downloadBackup(backup.file_name)),
                action('fa-solid fa-rotate-left', '恢复为新聊天', () => restoreBackup(backup.file_name, parsed.source, {
                    key: targetChat.characterKey,
                    character: targetChat.character,
                })),
                action('fa-regular fa-trash-can', '删除备份', async () => {
                    const deleted = await deleteBackups([backup.file_name]);
                    if (!deleted.length) return;
                    selected.delete(backup.file_name);
                    const deletedSet = new Set(deleted);
                    for (const group of groups) group.backups = group.backups.filter(item => !deletedSet.has(item.file_name));
                    groups = groupBackupsByChat(groups.flatMap(group => group.backups));
                    render();
                }, 'chm-backup-danger'),
            );
            row.append(icon, main, actions);
            list.append(row);
        }
        count.textContent = loading
            ? '正在识别聊天备份…'
            : search.value.trim() ? `${filtered.length} / ${allBackups().length} 份备份` : `${filtered.length} 份备份`;
        pagination.replaceChildren();
        const status = document.createElement('span');
        status.className = 'chm-page-status';
        status.textContent = filtered.length ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, filtered.length)} / ${filtered.length}` : '0 / 0';
        const pageButtons = [
            ['first', 'fa-solid fa-angles-left', '第一页'],
            ['previous', 'fa-solid fa-angle-left', '上一页'],
            ['next', 'fa-solid fa-angle-right', '下一页'],
            ['last', 'fa-solid fa-angles-right', '最后一页'],
        ].map(([direction, iconName, label]) => {
            const button = iconButton(iconName, label, 'chm-page-button');
            button.disabled = ['first', 'previous'].includes(direction) ? page <= 1 : page >= pageCount;
            button.addEventListener('click', () => {
                if (direction === 'first') page = 1;
                if (direction === 'previous') page = Math.max(1, page - 1);
                if (direction === 'next') page = Math.min(pageCount, page + 1);
                if (direction === 'last') page = pageCount;
                render();
                chatsPanel.scrollTop = 0;
            });
            return button;
        });
        const size = createSelect('chm-page-size chm-backups-page-size', '每页显示备份数', [10, 20, 30, 50].map(value => ({ value: String(value), label: `${value} / 页` })), pageSize);
        size.addEventListener('change', () => {
            pageSize = Number(size.value);
            page = 1;
            render();
        });
        pagination.append(status, ...pageButtons, size);
        updateBatchbar(pageBackups);
    };

    refreshBackups = async (force = false) => {
        if (loading || (loaded && !force)) return;
        loadController?.abort();
        loadController = new AbortController();
        loading = true;
        selected.clear();
        render();
        try {
            const response = await fetch('/api/backups/chat/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                signal: loadController.signal,
            });
            if (!response.ok) throw new Error('无法读取聊天备份列表');
            const source = String(targetChat.character?.avatar || '')
                .replace(/\.[^.]+$/i, '')
                .replace(/[^a-z0-9]/gi, '_')
                .toLowerCase();
            const backupList = await response.json();
            const backups = backupList.filter(backup => parseBackupName(backup.file_name).source.toLowerCase() === source);
            await identifyBackups(backups, loadController.signal, (done, total) => {
                count.textContent = `正在识别聊天… ${done}/${total}`;
            });
            const integrity = targetChat.metadata?.integrity || '';
            const candidateHashes = new Set([
                targetChat.metadata?.chat_id_hash,
                getStringHash(targetChat.fileName),
                targetChat.metadata?.main_chat ? getStringHash(targetChat.metadata.main_chat) : '',
                ...Object.entries(getLibrary(targetChat.characterKey).chatAliases)
                    .filter(([, currentName]) => currentName === targetChat.fileName)
                    .map(([oldName]) => getStringHash(oldName)),
            ].filter(Boolean).map(String));
            groups = groupBackupsByChat(backups).filter(group => (
                integrity ? group.identity === integrity : candidateHashes.has(String(group.chatHash))
            ));
            loaded = true;
            page = 1;
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('[Chats Manager] Backup page failed', error);
                toastr.error(error.message);
            }
        } finally {
            loading = false;
            render();
        }
    };

    wrapper.querySelector('.chm-backups-back').addEventListener('click', closeChatBackups);
    search.addEventListener('input', () => {
        page = 1;
        render();
    });
    wrapper.querySelector('.chm-backups-refresh').addEventListener('click', () => void refreshBackups(true));
    wrapper.querySelector('.chm-backups-batch-toggle').addEventListener('click', () => {
        batchMode = !batchMode;
        if (!batchMode) selected.clear();
        render();
    });
    wrapper.querySelector('.chm-backups-exit-batch').addEventListener('click', () => {
        batchMode = false;
        selected.clear();
        render();
    });
    wrapper.querySelector('.chm-backups-select-page').addEventListener('click', () => {
        const filtered = visibleBackups();
        const pageBackups = filtered.slice((page - 1) * pageSize, page * pageSize);
        const names = pageBackups.map(backup => backup.file_name);
        const shouldSelect = names.some(name => !selected.has(name));
        for (const name of names) shouldSelect ? selected.add(name) : selected.delete(name);
        render();
    });
    downloadSelected.addEventListener('click', () => {
        const backups = groups.flatMap(group => group.backups).filter(backup => selected.has(backup.file_name));
        void downloadBackupsAsZip(backups);
    });
    deleteSelected.addEventListener('click', async () => {
        const deleted = new Set(await deleteBackups([...selected]));
        if (!deleted.size) return;
        selected.forEach(name => { if (deleted.has(name)) selected.delete(name); });
        for (const group of groups) group.backups = group.backups.filter(backup => !deleted.has(backup.file_name));
        groups = groupBackupsByChat(groups.flatMap(group => group.backups));
        render();
    });
    render();
    return wrapper;
}

async function startNewChatForCharacter() {
    const target = await chooseTargetCharacter('选择要新建聊天的角色');
    if (!target) return;
    await selectCharacterById(target.id);
    await doNewChat({ deleteCurrentChat: false });
    browseAllCharacters = false;
    invalidateCharacterCache(target.key);
    await refreshChats();
}

async function openNativeManagerForCharacter() {
    const target = await chooseTargetCharacter('选择要管理聊天的角色');
    if (!target) return;
    await selectCharacterById(target.id);
    document.getElementById('option_select_chat')?.click();
}

async function batchMoveChats() {
    const chats = selectedChats();
    if (!chats.length) return;
    const grouped = new Map();
    for (const chat of chats) {
        if (!grouped.has(chat.characterKey)) grouped.set(chat.characterKey, []);
        grouped.get(chat.characterKey).push(chat);
    }
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = '批量移动到分组';
    content.append(title);
    for (const [key, roleChats] of grouped) {
        const row = document.createElement('label');
        row.className = 'chm-batch-folder-row';
        const name = document.createElement('span');
        name.textContent = getCharacterName(roleChats[0].character);
        const select = document.createElement('select');
        select.className = 'text_pole';
        select.dataset.characterKey = key;
        const keep = document.createElement('option');
        keep.value = '__keep__';
        keep.textContent = '保持原分组';
        const unfiled = document.createElement('option');
        unfiled.value = '';
        unfiled.textContent = '移出分组';
        select.append(keep, unfiled);
        for (const folder of getLibrary(key).folders) {
            const option = document.createElement('option');
            option.value = folder.id;
            option.textContent = folder.name;
            select.append(option);
        }
        row.append(name, select);
        content.append(row);
    }
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '移动', cancelButton: t`Cancel` });
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;
    for (const select of content.querySelectorAll('select[data-character-key]')) {
        if (select.value === '__keep__') continue;
        const key = select.dataset.characterKey;
        const library = getLibrary(key);
        const entry = getCachedCharacter(key);
        const rootNames = new Set(grouped.get(key).map(chat => getRootChatName(chat, entry)));
        for (const rootName of rootNames) {
            if (select.value) library.chatFolders[rootName] = select.value;
            else delete library.chatFolders[rootName];
        }
    }
    saveSettings();
    await refreshChats();
    scheduleNativeChatGrouping();
}

function menuAction(icon, label, handler, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chm-menu-action ${className}`.trim();
    button.innerHTML = `<i class="${icon}" aria-hidden="true"></i><span></span>`;
    button.querySelector('span').textContent = label;
    button.addEventListener('click', event => {
        event.stopPropagation();
        const popover = button.closest('.chm-row-menu-popover');
        const owner = button.closest('details') || popover?._chmOwnerDetails;
        owner?.removeAttribute('open');
        void handler();
    });
    return button;
}

function positionFloatingMenu(details, popover = details.querySelector('.chm-row-menu-popover')) {
    const summary = details.querySelector('summary');
    if (!summary || !popover) return;
    if (!details.open || !popover.isConnected) return;
    const anchor = summary.getBoundingClientRect();
    const menu = popover.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(anchor.right - menu.width, window.innerWidth - menu.width - margin));
    const fitsBelow = anchor.bottom + menu.height + margin <= window.innerHeight;
    const top = fitsBelow ? anchor.bottom + 4 : Math.max(margin, anchor.top - menu.height - 4);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.classList.remove('is-positioning');
}

function setupFloatingMenu(details, popover) {
    popover._chmOwnerDetails = details;
    details.addEventListener('toggle', () => {
        if (!details.open) {
            popover.classList.remove('is-portaled', 'is-positioning');
            popover.style.removeProperty('left');
            popover.style.removeProperty('top');
            details.append(popover);
            return;
        }
        chatsPanel?.querySelectorAll('details.chm-row-menu[open], details.chm-toolbar-menu[open]').forEach(other => {
            if (other !== details) other.removeAttribute('open');
        });
        popover.classList.add('is-portaled', 'is-positioning');
        document.body.append(popover);
        positionFloatingMenu(details, popover);
    });
}

function createChatActionsMenu(chat, { depth = 0, descendants = 0 } = {}) {
    const details = document.createElement('details');
    details.className = 'chm-row-menu';
    const summary = document.createElement('summary');
    summary.className = 'chm-icon-button';
    summary.title = '更多聊天操作';
    summary.setAttribute('aria-label', '更多聊天操作');
    summary.innerHTML = '<i class="fa-solid fa-ellipsis" aria-hidden="true"></i>';
    const menu = document.createElement('div');
    menu.className = 'chm-row-menu-popover';
    menu.append(
        menuAction(isChatPinned(chat) ? 'fa-solid fa-star' : 'fa-regular fa-star', isChatPinned(chat) ? '取消收藏' : '收藏聊天', async () => {
            toggleChatPin(chat);
            await refreshChats();
        }),
        menuAction('fa-regular fa-folder-open', depth || descendants ? '移动聊天树' : '移动到分组', () => chooseFolder(chat)),
        menuAction('fa-solid fa-file-export', '导出 JSONL', () => exportChats([chat], 'jsonl')),
        menuAction('fa-regular fa-file-lines', '导出 TXT', () => exportChats([chat], 'txt')),
        menuAction('fa-regular fa-trash-can', '删除聊天', () => deleteChats([chat]), 'chm-menu-danger'),
    );
    setupFloatingMenu(details, menu);
    details.addEventListener('click', event => event.stopPropagation());
    details.append(summary, menu);
    return details;
}

function renderChatNode(node, container, depth = 0, visibleQuery = '', options = {}) {
    if (!treeMatches(node, visibleQuery)) return;
    const chat = node.chat;
    const pinnedCopy = Boolean(options.pinnedCopy);
    const row = document.createElement('div');
    row.className = `chm-chat-row${depth ? ' is-branch' : ''}${pinnedCopy ? ' is-pinned-copy' : ''}`;
    row.style.setProperty('--branch-depth', depth);
    row.dataset.chatKey = `${chat.characterKey}::${chat.fileName}`;
    renderedChats.set(row.dataset.chatKey, chat);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const liveContext = SillyTavern.getContext();
    if (characterKey(liveContext.characters?.[liveContext.characterId]) === chat.characterKey && currentChatName() === chat.fileName) {
        row.classList.add('is-current');
    }
    if (isChatPinned(chat)) row.classList.add('is-pinned');
    if (chatsSelectedChats.has(row.dataset.chatKey)) row.classList.add('is-selected');

    const branchRail = document.createElement('div');
    branchRail.className = 'chm-branch-rail';
    branchRail.setAttribute('aria-hidden', 'true');
    const main = document.createElement('div');
    main.className = 'chm-chat-main';
    const titleLine = document.createElement('div');
    titleLine.className = 'chm-chat-title-line';
    if (pinnedCopy) {
        const characterName = document.createElement('span');
        characterName.className = 'chm-pinned-character';
        characterName.textContent = getCharacterName(chat.character);
        characterName.title = getCharacterName(chat.character);
        titleLine.append(characterName);
    }
    if (depth || (pinnedCopy && chat.metadata?.main_chat)) {
        const branchBadge = document.createElement('span');
        branchBadge.className = 'chm-branch-badge';
        branchBadge.innerHTML = '<i class="fa-solid fa-code-branch"></i> 分支';
        branchBadge.title = `父聊天：${node.parent?.chat.fileName || chat.metadata?.main_chat || ''}`;
        titleLine.append(branchBadge);
    }
    const title = document.createElement('span');
    title.className = 'chm-chat-title';
    title.textContent = chat.fileName;
    title.title = chat.fileName;
    titleLine.append(title);
    const descendants = subtreeCount(node);
    if (descendants) {
        const childCount = document.createElement('span');
        childCount.className = 'chm-child-count';
        childCount.innerHTML = `<i class="fa-solid fa-code-branch"></i> ${descendants}`;
        childCount.title = `${descendants} 个分支聊天`;
        titleLine.append(childCount);
    }
    const meta = document.createElement('div');
    meta.className = 'chm-chat-meta';
    const date = formatDate(chat.lastMessage);
    meta.textContent = [date, chat.itemCount ? `${chat.itemCount} 条消息` : ''].filter(Boolean).join(' · ');
    main.append(titleLine);
    const previewText = chatPreview(chat.message);
    if (previewText) {
        const preview = document.createElement('div');
        preview.className = 'chm-chat-preview';
        preview.textContent = previewText;
        preview.title = String(chat.message).replace(/\s+/g, ' ').trim();
        main.append(preview);
    }
    main.append(meta);

    const actions = document.createElement('div');
    actions.className = 'chm-row-actions';
    const rename = iconButton('fa-solid fa-pencil', '重命名聊天');
    rename.addEventListener('click', event => { event.stopPropagation(); void renameChat(chat); });
    const backups = iconButton('fa-solid fa-clock-rotate-left', '管理聊天备份', 'chm-chat-backups-button');
    backups.addEventListener('click', event => { event.stopPropagation(); openChatBackups(chat); });
    actions.append(rename, backups, createChatActionsMenu(chat, { depth, descendants }));
    row.append(branchRail);
    if (chatsBatchMode) {
        const select = document.createElement('label');
        select.className = 'chm-batch-select';
        select.title = `选择 ${chat.fileName}`;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'chm-batch-checkbox';
        checkbox.checked = chatsSelectedChats.has(row.dataset.chatKey);
        checkbox.addEventListener('click', event => event.stopPropagation());
        checkbox.addEventListener('change', () => setChatSelected(chat, checkbox.checked));
        select.addEventListener('click', event => event.stopPropagation());
        select.append(checkbox);
        row.append(select);
    }
    if (pinnedCopy) row.append(makeAvatar(chat.character, 'tiny'));
    row.append(main, actions);
    row.addEventListener('click', () => {
        if (chatsBatchMode) setChatSelected(chat, !chatsSelectedChats.has(row.dataset.chatKey));
        else void openChat(chat);
    });
    row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (chatsBatchMode) setChatSelected(chat, !chatsSelectedChats.has(row.dataset.chatKey));
            else void openChat(chat);
        }
    });
    container.append(row);
    if (!pinnedCopy) {
        for (const child of node.children) renderChatNode(child, container, depth + 1, visibleQuery);
    }
}

function renderFolderSection(entry, folder, roots, query, container) {
    const id = folder?.id || '__unfiled__';
    const section = document.createElement('section');
    section.className = 'chm-folder-section';
    const header = document.createElement('div');
    header.className = 'chm-folder-header';
    const collapseKey = `${entry.key}::${id}`;
    const collapsed = Boolean(settings().collapsedFolders[collapseKey]) && !query;
    if (collapsed) section.classList.add('is-collapsed');
    const caret = iconButton('fa-solid fa-chevron-down', collapsed ? '展开分组' : '收起分组', 'chm-caret');
    const folderIcon = document.createElement('i');
    folderIcon.className = folder ? 'fa-regular fa-folder' : 'fa-solid fa-inbox';
    const name = document.createElement('span');
    name.className = 'chm-folder-name';
    name.textContent = folder?.name || '未分组';
    const count = document.createElement('span');
    count.className = 'chm-count';
    count.textContent = String(roots.length);
    header.append(folderIcon, name, count);
    if (folder) {
        const rename = iconButton('fa-solid fa-pencil', '重命名分组');
        rename.addEventListener('click', event => { event.stopPropagation(); void renameFolder(entry.key, folder); });
        const remove = iconButton('fa-regular fa-trash-can', '删除分组', 'chm-danger');
        remove.addEventListener('click', event => { event.stopPropagation(); void deleteFolder(entry.key, folder); });
        header.append(rename, remove);
    }
    header.append(caret);
    const list = document.createElement('div');
    list.className = 'chm-chat-list';
    for (const root of roots) renderChatNode(root, list, 0, query);
    header.addEventListener('click', () => {
        settings().collapsedFolders[collapseKey] = section.classList.toggle('is-collapsed');
        saveSettings();
    });
    section.append(header, list);
    container.append(section);
}

async function requestCharacterDetailsManually(entry) {
    const policy = characterDetailPolicy(entry);
    if (!policy.automatic) {
        const content = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = '加载大型聊天详情？';
        const summary = document.createElement('p');
        summary.textContent = `需要扫描 ${policy.files} 个聊天文件，共 ${humanFileSize(policy.bytes)}。`;
        const warning = document.createElement('p');
        warning.className = 'chm-popup-note';
        warning.textContent = '这会读取所有聊天以识别分支、楼层数和末条预览，可能显著增加 Docker 容器或浏览器的内存占用。保持轻量模式最安全。';
        content.append(title, summary, warning);
        const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '仍要加载', cancelButton: t`Cancel` });
        if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;
    }
    const cached = getCachedCharacter(entry.key);
    if (!cached?.isSummary) return;
    cached.detailRetryAfter = 0;
    cached.detailState = 'loading';
    scheduleCharacterDetails({
        id: entry.id,
        key: entry.key,
        character: entry.character,
    }, characterCacheEpoch, { manual: true });
    await refreshChats();
}

function createCharacterBody(entry, query) {
    const body = document.createElement('div');
    body.className = 'chm-character-body';
    if (entry.isSummary) {
        const status = document.createElement('div');
        const requiresManualLoad = entry.detailState === 'manual';
        const canRetry = requiresManualLoad || entry.detailState === 'deferred';
        status.className = `chm-detail-status${canRetry ? ' is-deferred' : ''}`;
        const icon = document.createElement('i');
        icon.className = canRetry
            ? 'fa-solid fa-circle-exclamation'
            : 'fa-solid fa-circle-notch fa-spin';
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        if (requiresManualLoad) {
            const policy = characterDetailPolicy(entry);
            text.textContent = `轻量模式：${policy.files} 个聊天、${humanFileSize(policy.bytes)}，未自动扫描预览与分支`;
        } else {
            text.textContent = entry.detailState === 'deferred'
                ? '聊天名称已加载，预览与分支详情稍后重试'
                : '聊天名称已加载，正在后台补充分支与预览…';
        }
        status.append(icon, text);
        if (canRetry) {
            const retry = iconButton(requiresManualLoad ? 'fa-solid fa-database' : 'fa-solid fa-rotate', requiresManualLoad ? '手动加载完整详情' : '立即重试详情加载');
            retry.addEventListener('click', event => {
                event.stopPropagation();
                void requestCharacterDetailsManually(entry);
            });
            status.append(retry);
        }
        body.append(status);
    }
    const roots = buildChatTree(entry.chats).filter(root => treeMatches(root, query));
    const library = getLibrary(entry.key);
    const byFolder = new Map(library.folders.map(folder => [folder.id, []]));
    const unfiled = [];
    for (const root of roots) {
        const folderId = library.chatFolders[root.chat.fileName];
        if (folderId && byFolder.has(folderId)) byFolder.get(folderId).push(root);
        else unfiled.push(root);
    }
    const folders = [...library.folders];
    if (!folders.length) {
        body.classList.add('is-flat');
        for (const root of unfiled) renderChatNode(root, body, 0, query);
    } else {
        body.classList.add('has-folders');
        const folderSections = folders.map(folder => ({ folder, roots: byFolder.get(folder.id) || [] }));
        if (unfiled.length) folderSections.push({ folder: null, roots: unfiled });
        folderSections.sort((a, b) => (
            rootsLatestTimestamp(b.roots) - rootsLatestTimestamp(a.roots)
            || (a.folder?.name || '').localeCompare(b.folder?.name || '')
        ));
        for (const item of folderSections) {
            if (!item.folder) {
                for (const root of item.roots) renderChatNode(root, body, 0, query);
            } else if (item.roots.length || !query) {
                renderFolderSection(entry, item.folder, item.roots, query, body);
            }
        }
    }
    return body;
}

function renderCharacterSection(entry, query, container) {
    const section = document.createElement('section');
    section.className = 'chm-character-section';
    const collapsed = Boolean(settings().collapsedCharacters[entry.key]) && !query;
    if (collapsed) section.classList.add('is-collapsed');
    const header = document.createElement('div');
    header.className = 'chm-character-header';
    const caret = iconButton('fa-solid fa-chevron-down', collapsed ? '展开角色' : '收起角色', 'chm-caret');
    const avatar = makeAvatar(entry.character);
    const identity = document.createElement('div');
    identity.className = 'chm-character-identity';
    const name = document.createElement('strong');
    name.textContent = getCharacterName(entry.character);
    const summary = document.createElement('span');
    summary.textContent = pluralCount(entry.chats.length);
    identity.append(name, summary);
    header.append(avatar, identity, caret);
    header.addEventListener('click', () => {
        settings().collapsedCharacters[entry.key] = section.classList.toggle('is-collapsed');
        saveSettings();
    });
    const body = createCharacterBody(entry, query);
    section.append(header, body);
    container.append(section);
}

function renderFocusedCharacter(entry, query, container) {
    const section = document.createElement('section');
    section.className = 'chm-character-section chm-focused-character';
    section.append(createCharacterBody(entry, query));
    container.append(section);
}

function chatMatchesQuery(chat, query) {
    if (!query) return true;
    return `${getCharacterName(chat.character)} ${chat.fileName} ${chat.message}`.toLocaleLowerCase().includes(query);
}

function renderPinnedSection(entries, query, container) {
    const chats = entries
        .flatMap(entry => entry.chats)
        .filter(chat => isChatPinned(chat) && chatMatchesQuery(chat, query))
        .sort((a, b) => chatTimestamp(b) - chatTimestamp(a));
    if (!chats.length) return;
    const section = document.createElement('section');
    section.className = 'chm-pinned-section';
    if (settings().collapsedPinned && !query) section.classList.add('is-collapsed');
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'chm-pinned-header';
    header.innerHTML = '<i class="fa-solid fa-star" aria-hidden="true"></i><span>收藏聊天</span>';
    const count = document.createElement('span');
    count.className = 'chm-count';
    count.textContent = String(chats.length);
    header.append(count);
    const caret = document.createElement('i');
    caret.className = 'fa-solid fa-chevron-down chm-pinned-caret';
    caret.setAttribute('aria-hidden', 'true');
    header.append(caret);
    header.setAttribute('aria-expanded', String(!section.classList.contains('is-collapsed')));
    const list = document.createElement('div');
    list.className = 'chm-chat-list chm-pinned-list';
    for (const chat of chats) {
        renderChatNode({ chat, children: [], parent: null }, list, 0, '', { pinnedCopy: true });
    }
    header.addEventListener('click', () => {
        const collapsed = section.classList.toggle('is-collapsed');
        header.setAttribute('aria-expanded', String(!collapsed));
        settings().collapsedPinned = collapsed;
        saveSettings();
    });
    section.append(header, list);
    container.append(section);
}

function updateCharacterViewControls(activeEntry, focused) {
    if (!chatsPanel) return;
    chatsPanel.classList.toggle('is-character-focus', focused);
    if (focused && activeEntry) chatsPanel.dataset.focusCharacterKey = activeEntry.key;
    else delete chatsPanel.dataset.focusCharacterKey;
    const toggle = chatsPanel.querySelector('.chm-focus-toggle');
    if (!toggle) return;
    toggle.hidden = !activeEntry;
    if (!activeEntry) return;
    toggle.dataset.target = focused ? 'all' : 'current';
    toggle.title = focused ? '返回全部角色聊天' : `只看 ${getCharacterName(activeEntry.character)} 的聊天`;
    toggle.innerHTML = focused
        ? '<i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>全部角色</span>'
        : '<i class="fa-solid fa-user" aria-hidden="true"></i><span>当前角色</span>';
    const expand = chatsPanel.querySelector('.chm-expand-all');
    const collapse = chatsPanel.querySelector('.chm-collapse-all');
    const expandTitle = focused ? '展开当前角色的全部分组' : '展开全部角色和分组';
    const collapseTitle = focused ? '折叠当前角色的全部分组' : '折叠全部角色和分组';
    if (expand) {
        expand.title = expandTitle;
        expand.setAttribute('aria-label', expandTitle);
    }
    if (collapse) {
        collapse.title = collapseTitle;
        collapse.setAttribute('aria-label', collapseTitle);
    }
}

function descriptorTimestamp(descriptor) {
    const value = Number(descriptor.character?.date_last_chat) || 0;
    return Number.isFinite(value) ? value : 0;
}

function entryTimestamp(entry) {
    return Math.max(...entry.chats.map(chatTimestamp), descriptorTimestamp(entry), 0);
}

function hasPinnedChatForCharacter(characterKeyValue) {
    const prefix = `${characterKeyValue}::`;
    return settings().pinnedChats.some(key => key.startsWith(prefix));
}

async function refreshChats(force = false, { background = false } = {}) {
    if (!chatsPanel) return;
    const generation = ++loadGeneration;
    const query = chatsPanel.querySelector('.chm-search-input')?.value.trim().toLocaleLowerCase() || '';
    const list = chatsPanel.querySelector('.chm-sections');
    const loading = chatsPanel.querySelector('.chm-loading');
    if (!list || !loading) return;
    if (!background) {
        loading.hidden = false;
        list.classList.add('is-loading');
    }
    try {
    const descriptors = getCharacterDescriptors();
    const activeKey = getActiveCharacterKey();
    const activeDescriptor = activeKey ? descriptors.find(entry => entry.key === activeKey) : null;
    const focused = Boolean(activeDescriptor && !browseAllCharacters);
    let activeEntry = null;
    if (focused) activeEntry = await loadCharacterEntry(activeDescriptor, force);
    if (generation !== loadGeneration) return;
    list.replaceChildren();
    renderedChats.clear();
    updateCharacterViewControls(activeEntry || activeDescriptor, focused);
    if (focused) {
        const matches = !query
            || getCharacterName(activeEntry.character).toLocaleLowerCase().includes(query)
            || activeEntry.chats.some(chat => `${chat.fileName} ${chat.message}`.toLocaleLowerCase().includes(query));
        updatePagination(matches ? 1 : 0, 0, matches ? 1 : 0, 1);
        if (matches) {
            renderPinnedSection([activeEntry], query, list);
            renderFocusedCharacter(activeEntry, query, list);
        }
        else {
            const empty = document.createElement('div');
            empty.className = 'chm-empty';
            empty.innerHTML = '<i class="fa-regular fa-comments"></i><span>当前角色没有匹配的聊天</span>';
            list.append(empty);
        }
        return;
    }
    const candidates = descriptors.filter(likelyHasChats);
    const pageSize = Number(settings().pageSize) || 10;
    const needsFullIndex = Boolean(query) || settings().sortMode === 'chats';
    let visible = [];
    let pageEntries = [];
    let pinnedEntries = [];
    let start = 0;

    if (needsFullIndex) {
        const characters = (await loadCharacterEntries(candidates, force)).filter(entry => entry.chats.length > 0);
        if (generation !== loadGeneration) return;
        visible = characters.filter(entry => !query
            || getCharacterName(entry.character).toLocaleLowerCase().includes(query)
            || entry.chats.some(chat => `${chat.fileName} ${chat.message}`.toLocaleLowerCase().includes(query)));
        const sorters = {
            recent: (a, b) => entryTimestamp(b) - entryTimestamp(a) || getCharacterName(a.character).localeCompare(getCharacterName(b.character)),
            name: (a, b) => getCharacterName(a.character).localeCompare(getCharacterName(b.character)),
            chats: (a, b) => b.chats.length - a.chats.length || getCharacterName(a.character).localeCompare(getCharacterName(b.character)),
        };
        visible.sort(sorters[settings().sortMode] || sorters.recent);
        const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
        currentPage = Math.min(Math.max(1, currentPage), totalPages);
        start = (currentPage - 1) * pageSize;
        pageEntries = visible.slice(start, start + pageSize);
        pinnedEntries = characters.filter(entry => hasPinnedChatForCharacter(entry.key));
        updatePagination(visible.length, start, pageEntries.length, totalPages);
    } else {
        const sorted = [...candidates];
        if (settings().sortMode === 'name') {
            sorted.sort((a, b) => getCharacterName(a.character).localeCompare(getCharacterName(b.character)));
        } else {
            sorted.sort((a, b) => descriptorTimestamp(b) - descriptorTimestamp(a) || getCharacterName(a.character).localeCompare(getCharacterName(b.character)));
        }
        const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
        currentPage = Math.min(Math.max(1, currentPage), totalPages);
        start = (currentPage - 1) * pageSize;
        const pageDescriptors = sorted.slice(start, start + pageSize);
        const pinnedDescriptors = candidates.filter(entry => hasPinnedChatForCharacter(entry.key));
        const loaded = await loadCharacterEntries([...pageDescriptors, ...pinnedDescriptors], force);
        if (generation !== loadGeneration) return;
        const loadedByKey = new Map(loaded.map(entry => [entry.key, entry]));
        pageEntries = pageDescriptors.map(entry => loadedByKey.get(entry.key)).filter(entry => entry?.chats.length);
        pinnedEntries = pinnedDescriptors.map(entry => loadedByKey.get(entry.key)).filter(entry => entry?.chats.length);
        visible = sorted;
        updatePagination(sorted.length, start, pageEntries.length, totalPages);
    }
    renderPinnedSection(pinnedEntries, query, list);
    for (const entry of pageEntries) renderCharacterSection(entry, query, list);
    if (!visible.length || (!pageEntries.length && !pinnedEntries.length)) {
        const empty = document.createElement('div');
        empty.className = 'chm-empty';
        empty.innerHTML = visible.length
            ? '<i class="fa-solid fa-triangle-exclamation"></i><span>当前页的聊天暂时无法读取，请点击刷新重试</span>'
            : '<i class="fa-regular fa-comments"></i><span>没有找到聊天</span>';
        list.append(empty);
    }
    } catch (error) {
        if (generation !== loadGeneration) return;
        console.error('[Chats Manager] Failed to refresh chat list', error);
        renderedChats.clear();
        const failure = document.createElement('div');
        failure.className = 'chm-empty chm-load-error';
        const message = document.createElement('span');
        message.textContent = '聊天列表加载失败';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'menu_button';
        retry.innerHTML = '<i class="fa-solid fa-rotate" aria-hidden="true"></i><span>重试</span>';
        retry.addEventListener('click', () => {
            invalidateCharacterCache();
            void refreshChats(true);
        });
        failure.append(message, retry);
        list.replaceChildren(failure);
    } finally {
        if (generation === loadGeneration) {
            loading.hidden = true;
            list.classList.remove('is-loading');
        }
    }
}

function updatePagination(total, start, displayed, totalPages) {
    if (!chatsPanel) return;
    const status = chatsPanel.querySelector('.chm-page-status');
    if (status) status.textContent = total ? `${start + 1}-${start + displayed} / ${total}` : '0 / 0';
    for (const button of chatsPanel.querySelectorAll('.chm-page-button')) {
        const direction = button.dataset.page;
        button.dataset.totalPages = String(totalPages);
        button.disabled = direction === 'first' || direction === 'previous' ? currentPage <= 1 : currentPage >= totalPages;
    }
}

function createSelect(className, label, options, value) {
    const select = document.createElement('select');
    select.className = `text_pole ${className}`;
    select.setAttribute('aria-label', label);
    select.title = label;
    for (const optionData of options) {
        const option = document.createElement('option');
        option.value = optionData.value;
        option.textContent = optionData.label;
        select.append(option);
    }
    select.value = String(value);
    if (!select.value && options.length) select.value = options[0].value;
    return select;
}

async function setAllCollapsed(collapsed) {
    const allEntries = getCharacterDescriptors().filter(likelyHasChats);
    const focusedKey = chatsPanel?.dataset.focusCharacterKey || '';
    const entries = focusedKey ? allEntries.filter(entry => entry.key === focusedKey) : allEntries;
    const state = settings();
    for (const entry of entries) {
        if (!focusedKey) {
            if (collapsed) state.collapsedCharacters[entry.key] = true;
            else delete state.collapsedCharacters[entry.key];
        }
        for (const folder of getLibrary(entry.key).folders) {
            const key = `${entry.key}::${folder.id}`;
            if (collapsed) state.collapsedFolders[key] = true;
            else delete state.collapsedFolders[key];
        }
    }
    saveSettings();
    await refreshChats();
}

function makeChatsPanel() {
    const wrapper = document.createElement('div');
    wrapper.id = 'chats-manager-chats';
    wrapper.className = 'chm-tab-panel';
    wrapper.hidden = true;
    const toolbar = document.createElement('div');
    toolbar.className = 'chm-toolbar';
    const searchBox = document.createElement('div');
    searchBox.className = 'chm-search';
    searchBox.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole chm-search-input';
    search.placeholder = '搜索角色、聊天或消息…';
    search.setAttribute('aria-label', '搜索聊天');
    let debounce;
    search.addEventListener('input', () => {
        clearTimeout(debounce);
        currentPage = 1;
        debounce = setTimeout(() => void refreshChats(), 120);
    });
    searchBox.append(search);
    const refresh = iconButton('fa-solid fa-rotate', '刷新聊天列表', 'chm-refresh');
    refresh.addEventListener('click', () => {
        invalidateCharacterCache();
        void refreshChats();
    });
    const toolbarMenu = document.createElement('details');
    toolbarMenu.className = 'chm-toolbar-menu';
    const toolbarMenuToggle = document.createElement('summary');
    toolbarMenuToggle.className = 'chm-icon-button chm-toolbar-menu-toggle';
    toolbarMenuToggle.title = '聊天管理功能';
    toolbarMenuToggle.setAttribute('aria-label', '聊天管理功能');
    toolbarMenuToggle.innerHTML = '<i class="fa-solid fa-ellipsis" aria-hidden="true"></i>';
    const toolbarMenuPopover = document.createElement('div');
    toolbarMenuPopover.className = 'chm-row-menu-popover chm-toolbar-menu-popover';
    toolbarMenuPopover.append(
        menuAction('fa-solid fa-plus', '新聊天', () => startNewChatForCharacter()),
        menuAction('fa-solid fa-file-import', '导入聊天', () => importChatsToCharacter()),
        menuAction('fa-solid fa-address-book', '打开原生管理器', () => openNativeManagerForCharacter()),
    );
    toolbarMenu.addEventListener('click', event => event.stopPropagation());
    setupFloatingMenu(toolbarMenu, toolbarMenuPopover);
    toolbarMenu.append(toolbarMenuToggle, toolbarMenuPopover);
    const batchToggle = iconButton('fa-solid fa-pen-to-square', '批量编辑聊天', 'chm-batch-toggle');
    batchToggle.addEventListener('click', () => {
        chatsBatchMode = !chatsBatchMode;
        if (!chatsBatchMode) chatsSelectedChats.clear();
        void refreshChats();
        updateChatsBatchUi();
    });
    toolbar.append(searchBox, toolbarMenu, batchToggle, refresh);

    const controls = document.createElement('div');
    controls.className = 'chm-list-controls';
    const sort = createSelect('chm-sort-select', '角色排序顺序', [
        { value: 'recent', label: '最近聊天' },
        { value: 'name', label: '角色名称' },
        { value: 'chats', label: '聊天数量' },
    ], settings().sortMode);
    sort.addEventListener('change', () => {
        settings().sortMode = sort.value;
        currentPage = 1;
        saveSettings();
        void refreshChats();
    });
    const viewControls = document.createElement('div');
    viewControls.className = 'chm-view-controls';
    const focusToggle = document.createElement('button');
    focusToggle.type = 'button';
    focusToggle.className = 'chm-focus-toggle';
    focusToggle.hidden = true;
    focusToggle.addEventListener('click', () => {
        browseAllCharacters = focusToggle.dataset.target === 'all';
        currentPage = 1;
        void refreshChats();
    });
    const expandAll = iconButton('fa-solid fa-angles-down', '展开全部角色和分组', 'chm-collapse-button chm-expand-all');
    expandAll.addEventListener('click', () => void setAllCollapsed(false));
    const collapseAll = iconButton('fa-solid fa-angles-up', '折叠全部角色和分组', 'chm-collapse-button chm-collapse-all');
    collapseAll.addEventListener('click', () => void setAllCollapsed(true));
    viewControls.append(sort, expandAll, collapseAll, focusToggle);
    const pagination = document.createElement('div');
    pagination.className = 'chm-pagination';
    const status = document.createElement('span');
    status.className = 'chm-page-status';
    status.textContent = '0 / 0';
    const pageButtons = [
        { page: 'first', icon: 'fa-solid fa-angles-left', title: '第一页' },
        { page: 'previous', icon: 'fa-solid fa-angle-left', title: '上一页' },
        { page: 'next', icon: 'fa-solid fa-angle-right', title: '下一页' },
        { page: 'last', icon: 'fa-solid fa-angles-right', title: '最后一页' },
    ].map(data => {
        const button = iconButton(data.icon, data.title, 'chm-page-button');
        button.dataset.page = data.page;
        button.addEventListener('click', () => {
            const total = Number(button.dataset.totalPages) || 1;
            if (data.page === 'first') currentPage = 1;
            if (data.page === 'previous') currentPage = Math.max(1, currentPage - 1);
            if (data.page === 'next') currentPage = Math.min(total, currentPage + 1);
            if (data.page === 'last') currentPage = total;
            void refreshChats();
        });
        return button;
    });
    const pageSize = createSelect('chm-page-size', '每页显示角色数', [10, 20, 30, 50].map(size => ({ value: String(size), label: `${size} / 页` })), settings().pageSize);
    pageSize.addEventListener('change', () => {
        settings().pageSize = Number(pageSize.value);
        currentPage = 1;
        saveSettings();
        void refreshChats();
    });
    pagination.append(status, ...pageButtons, pageSize);
    controls.append(viewControls, pagination);
    const batchBar = document.createElement('div');
    batchBar.className = 'chm-batch-bar';
    batchBar.hidden = true;
    const selectAll = menuAction('fa-solid fa-check-double', '全选当前列表', async () => {
        const chats = [...renderedChats.values()];
        const allSelected = chats.length > 0 && chats.every(chat => chatsSelectedChats.has(chatPinKey(chat)));
        for (const chat of chats) {
            if (allSelected) chatsSelectedChats.delete(chatPinKey(chat));
            else chatsSelectedChats.set(chatPinKey(chat), chat);
        }
        updateChatsBatchUi();
    });
    selectAll.classList.add('chm-batch-select-all');
    const batchCount = document.createElement('span');
    batchCount.className = 'chm-batch-count';
    batchCount.textContent = '已选 0';
    const pin = menuAction('fa-regular fa-star', '收藏', async () => {
        const chats = selectedChats();
        const shouldPin = chats.some(chat => !isChatPinned(chat));
        chats.forEach(chat => setChatPinned(chat, shouldPin));
        saveSettings();
        await refreshChats();
    });
    pin.classList.add('chm-batch-pin');
    const move = menuAction('fa-regular fa-folder-open', '分组', () => batchMoveChats());
    move.classList.add('chm-batch-move');
    const jsonl = menuAction('fa-solid fa-file-export', 'JSONL', () => exportChats(selectedChats(), 'jsonl'));
    const txt = menuAction('fa-regular fa-file-lines', 'TXT', () => exportChats(selectedChats(), 'txt'));
    const remove = menuAction('fa-regular fa-trash-can', '删除', () => deleteChats(selectedChats()), 'chm-menu-danger');
    for (const button of [pin, move, jsonl, txt, remove]) button.dataset.requiresSelection = 'true';
    batchBar.append(selectAll, batchCount, pin, move, jsonl, txt, remove);
    const loading = document.createElement('div');
    loading.className = 'chm-loading';
    loading.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>正在整理聊天…</span>';
    const sections = document.createElement('div');
    sections.className = 'chm-sections';
    wrapper.append(toolbar, controls, batchBar, loading, sections);
    wrapper.addEventListener('scroll', () => {
        wrapper.querySelectorAll('details.chm-row-menu[open], details.chm-toolbar-menu[open]').forEach(details => details.removeAttribute('open'));
    }, { passive: true });
    wrapper.addEventListener('click', event => {
        if (event.target.closest('details')) return;
        wrapper.querySelectorAll('details.chm-row-menu[open], details.chm-toolbar-menu[open]').forEach(details => details.removeAttribute('open'));
    });
    queueMicrotask(updateChatsBatchUi);
    return wrapper;
}

function adoptCharacterContent(menu, characterPanel) {
    const chatsPlusCharacters = menu.querySelector('#chatsplus-characters-tab');
    if (chatsPlusCharacters) {
        characterPanel.append(...chatsPlusCharacters.childNodes);
        menu.querySelector('#chatsplus-selected-chat-wrapper')?.remove();
        menu.querySelector('#chatsplus-tab-row')?.remove();
        menu.querySelector('#chatsplus-tab-content-wrapper')?.remove();
        console.info('[Chats Manager] Adopted the native character content from ChatsPlus. Disable ChatsPlus to avoid duplicate work.');
        return;
    }
    const anchor = menu.querySelector('#CharListButtonAndHotSwaps');
    if (!anchor) return;
    const nodes = [];
    let sibling = anchor.nextElementSibling;
    while (sibling) {
        const next = sibling.nextElementSibling;
        if (sibling.id !== ROOT_ID && sibling.tagName !== 'HR') nodes.push(sibling);
        sibling = next;
    }
    characterPanel.append(...nodes);
}

function installTabs() {
    const menu = document.getElementById('right-nav-panel');
    const anchor = menu?.querySelector('#CharListButtonAndHotSwaps');
    if (!menu || !anchor || menu.querySelector(`#${ROOT_ID}`)) return false;
    panel = document.createElement('div');
    panel.id = ROOT_ID;
    const tabs = document.createElement('div');
    tabs.className = 'chm-tabs';
    tabs.setAttribute('role', 'tablist');
    const characterButton = document.createElement('button');
    characterButton.type = 'button';
    characterButton.className = 'chm-tab is-active';
    characterButton.textContent = t`Characters`;
    const chatsButton = document.createElement('button');
    chatsButton.type = 'button';
    chatsButton.className = 'chm-tab';
    chatsButton.textContent = t`Chats`;
    tabs.append(characterButton, chatsButton);
    const content = document.createElement('div');
    content.className = 'chm-content';
    const characterPanel = document.createElement('div');
    characterPanel.id = 'chats-manager-characters';
    characterPanel.className = 'chm-tab-panel';
    chatsPanel = makeChatsPanel();
    adoptCharacterContent(menu, characterPanel);
    content.append(characterPanel, chatsPanel);
    panel.append(tabs, content);
    anchor.insertAdjacentElement('afterend', panel);

    activateTab = name => {
        const chatsActive = name === 'chats';
        characterButton.classList.toggle('is-active', !chatsActive);
        chatsButton.classList.toggle('is-active', chatsActive);
        characterPanel.hidden = chatsActive;
        chatsPanel.hidden = !chatsActive;
        settings().defaultTab = chatsActive ? 'chats' : 'characters';
        saveSettings();
        if (chatsActive) void refreshChats();
    };
    characterButton.addEventListener('click', () => {
        activateTab('characters');
    });
    chatsButton.addEventListener('click', () => activateTab('chats'));
    document.getElementById('rm_button_characters')?.addEventListener('click', () => {
        browseAllCharacters = true;
        activateTab?.('characters');
    });
    activateTab(settings().defaultTab === 'chats' ? 'chats' : 'characters');
    return true;
}

function selectedNativeChatNames() {
    return [...nativeSelectedChats];
}

function setNativeBatchBusy(busy) {
    const toolbar = document.querySelector('.chm-native-batch-toolbar');
    if (!toolbar) return;
    toolbar.classList.toggle('is-busy', busy);
    toolbar.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    const toggle = document.querySelector('.chm-native-batch-toggle');
    if (toggle) toggle.disabled = busy;
}

function updateNativeBatchToolbar() {
    const toolbar = document.querySelector('.chm-native-batch-toolbar');
    if (!toolbar) return;
    toolbar.classList.toggle('is-active', nativeBatchMode);
    const toggle = document.querySelector('.chm-native-batch-toggle');
    const actions = toolbar.querySelector('.chm-native-batch-actions');
    const count = toolbar.querySelector('.chm-native-selected-count');
    if (toggle) toggle.innerHTML = nativeBatchMode
        ? '<i class="fa-solid fa-xmark"></i><span>退出批量</span>'
        : '<i class="fa-solid fa-list-check"></i><span>批量管理</span>';
    if (actions) actions.hidden = !nativeBatchMode;
    toolbar.hidden = !nativeBatchMode || !nativeBatchCharacterKey;
    if (count) count.textContent = `已选 ${nativeSelectedChats.size}`;
    toolbar.querySelectorAll('[data-requires-selection]').forEach(button => {
        button.disabled = nativeSelectedChats.size === 0;
    });
    document.querySelectorAll('#select_chat_div .select_chat_block_wrapper').forEach(wrapper => {
        const selected = nativeSelectedChats.has(nativeChatFileName(wrapper));
        wrapper.classList.toggle('chm-native-selected', selected);
        const checkbox = wrapper.querySelector('.chm-native-select-input');
        if (checkbox) checkbox.checked = selected;
    });
}

function attachNativeBatchCheckbox(wrapper) {
    wrapper.querySelector('.chm-native-select')?.remove();
    wrapper.classList.remove('chm-native-batch-row');
    wrapper.classList.remove('chm-native-selected');
    if (!nativeBatchMode) return;
    wrapper.classList.add('chm-native-batch-row');
    const fileName = nativeChatFileName(wrapper);
    const label = document.createElement('label');
    label.className = 'chm-native-select';
    label.title = `选择 ${fileName}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'chm-native-select-input';
    checkbox.checked = nativeSelectedChats.has(fileName);
    checkbox.addEventListener('change', () => {
        if (checkbox.checked) nativeSelectedChats.add(fileName);
        else nativeSelectedChats.delete(fileName);
        updateNativeBatchToolbar();
    });
    label.addEventListener('click', event => event.stopPropagation());
    label.append(checkbox);
    wrapper.prepend(label);
    wrapper.classList.toggle('chm-native-selected', checkbox.checked);
}

async function batchExportNativeChats(format) {
    const names = selectedNativeChatNames();
    if (!names.length) return;
    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId];
    if (!character || context.groupId) return toastr.error('批量导出目前只支持角色聊天。');
    setNativeBatchBusy(true);
    let exported = 0;
    try {
        await context.saveChat?.();
        for (const name of names) {
            const response = await fetch('/api/chats/export', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    is_group: false,
                    avatar_url: character.avatar,
                    file: `${name}.jsonl`,
                    exportfilename: `${name}.${format}`,
                    format,
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.message || `无法导出 ${name}`);
            download(data.result, `${name}.${format}`, format === 'txt' ? 'text/plain' : 'application/octet-stream');
            exported++;
        }
        toastr.success(`已导出 ${exported} 个聊天文件`);
    } catch (error) {
        console.error('[Chats Manager] Batch export failed', error);
        toastr.error(`批量导出中断：${error.message}`);
    } finally {
        setNativeBatchBusy(false);
        updateNativeBatchToolbar();
    }
}

async function batchMoveNativeChats() {
    const names = selectedNativeChatNames();
    if (!names.length) return;
    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId];
    if (!character || context.groupId) return;
    let entry = getCachedCharacter(characterKey(character));
    if (!entry) {
        entry = await loadCharacterEntry({
            id: String(context.characterId),
            character,
            key: characterKey(character),
        });
    }
    const library = getLibrary(entry.key);
    if (!library.folders.length) return toastr.info('请先在 Chats 页面创建一个聊天分组。');
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = `移动 ${names.length} 个聊天到分组`;
    const select = document.createElement('select');
    select.className = 'text_pole wide100p';
    const unfiled = document.createElement('option');
    unfiled.value = '';
    unfiled.textContent = '移出分组';
    select.append(unfiled);
    for (const folder of library.folders) {
        const option = document.createElement('option');
        option.value = folder.id;
        option.textContent = folder.name;
        select.append(option);
    }
    content.append(title, select);
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '移动', cancelButton: t`Cancel` });
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;
    const chatsByName = new Map(entry.chats.map(chat => [chat.fileName, chat]));
    for (const name of names) {
        const chat = chatsByName.get(name);
        const rootName = chat ? getRootChatName(chat, entry) : name;
        if (select.value) library.chatFolders[rootName] = select.value;
        else delete library.chatFolders[rootName];
    }
    saveSettings();
    if (chatsPanel && !chatsPanel.hidden) await refreshChats();
    scheduleNativeChatGrouping();
    toastr.success(`已整理 ${names.length} 个聊天`);
}

async function batchDeleteNativeChats() {
    const names = selectedNativeChatNames();
    if (!names.length) return;
    const context = SillyTavern.getContext();
    const characterId = context.characterId;
    const character = context.characters?.[characterId];
    if (!character || context.groupId) return toastr.error('批量删除目前只支持角色聊天。');
    const content = document.createElement('div');
    const question = document.createElement('h3');
    question.textContent = `确定删除选中的 ${names.length} 个聊天吗？`;
    const warning = document.createElement('p');
    warning.className = 'chm-popup-note';
    warning.textContent = '聊天文件会被永久删除，此操作无法撤销。';
    const preview = document.createElement('p');
    preview.className = 'chm-native-delete-preview';
    preview.textContent = names.slice(0, 5).join('、') + (names.length > 5 ? ` 等 ${names.length} 个聊天` : '');
    content.append(question, warning, preview);
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: t`Cancel` });
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;
    setNativeBatchBusy(true);
    try {
        await context.saveChat?.();
        const library = getLibrary(characterKey(character));
        for (const name of names) {
            await deleteCharacterChatByName(String(characterId), name);
            delete library.chatFolders[name];
            delete library.chatAliases[name];
            for (const [oldName, currentName] of Object.entries(library.chatAliases)) {
                if (currentName === name) delete library.chatAliases[oldName];
            }
            settings().pinnedChats = settings().pinnedChats.filter(key => key !== `${characterKey(character)}::${name}`);
            document.querySelectorAll('#select_chat_div .select_chat_block_wrapper').forEach(wrapper => {
                if (nativeChatFileName(wrapper) === name) wrapper.remove();
            });
        }
        nativeSelectedChats.clear();
        invalidateCharacterCache(characterKey(character));
        saveSettings();
        scheduleNativeChatGrouping();
        if (chatsPanel && !chatsPanel.hidden) await refreshChats();
        toastr.success(`已删除 ${names.length} 个聊天`);
    } catch (error) {
        console.error('[Chats Manager] Batch delete failed', error);
        toastr.error(`批量删除中断：${error.message}`);
    } finally {
        setNativeBatchBusy(false);
        updateNativeBatchToolbar();
    }
}

function ensureNativeBatchToolbar() {
    const container = document.getElementById('select_chat_div');
    if (!container) return;
    let toggle = document.querySelector('.chm-native-batch-toggle');
    if (!toggle) {
        toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'menu_button menu_button_icon chm-native-batch-toggle';
        toggle.innerHTML = '<i class="fa-solid fa-list-check"></i><span>批量管理</span>';
        toggle.addEventListener('click', () => {
            nativeBatchMode = !nativeBatchMode;
            if (!nativeBatchMode) nativeSelectedChats.clear();
            scheduleNativeChatGrouping();
            updateNativeBatchToolbar();
        });
    }
    const search = document.getElementById('select_chat_search');
    if (search) search.before(toggle);
    let toolbar = document.querySelector('.chm-native-batch-toolbar');
    if (toolbar) {
        updateNativeBatchToolbar();
        return;
    }
    toolbar = document.createElement('div');
    toolbar.className = 'chm-native-batch-toolbar';
    toolbar.innerHTML = `
        <div class="chm-native-batch-actions">
            <button type="button" class="chm-native-tool-button chm-native-select-all" title="选择当前搜索结果"><i class="fa-regular fa-square-check"></i><span>全选</span></button>
            <span class="chm-native-selected-count">已选 0</span>
            <button type="button" class="chm-native-tool-button chm-native-batch-move" data-requires-selection title="批量移动到分组"><i class="fa-regular fa-folder-open"></i><span>分组</span></button>
            <button type="button" class="chm-native-tool-button chm-native-batch-jsonl" data-requires-selection title="批量导出 JSONL"><i class="fa-solid fa-file-export"></i><span>JSONL</span></button>
            <button type="button" class="chm-native-tool-button chm-native-batch-txt" data-requires-selection title="批量导出 TXT"><i class="fa-regular fa-file-lines"></i><span>TXT</span></button>
            <button type="button" class="chm-native-tool-button chm-native-batch-delete" data-requires-selection title="批量删除"><i class="fa-regular fa-trash-can"></i><span>删除</span></button>
        </div>`;
    container.before(toolbar);
    toolbar.querySelector('.chm-native-select-all').addEventListener('click', () => {
        const wrappers = [...document.querySelectorAll('#select_chat_div .select_chat_block_wrapper')];
        const names = wrappers.map(nativeChatFileName).filter(Boolean);
        const allSelected = names.length > 0 && names.every(name => nativeSelectedChats.has(name));
        names.forEach(name => allSelected ? nativeSelectedChats.delete(name) : nativeSelectedChats.add(name));
        updateNativeBatchToolbar();
    });
    toolbar.querySelector('.chm-native-batch-move').addEventListener('click', () => void batchMoveNativeChats());
    toolbar.querySelector('.chm-native-batch-jsonl').addEventListener('click', () => void batchExportNativeChats('jsonl'));
    toolbar.querySelector('.chm-native-batch-txt').addEventListener('click', () => void batchExportNativeChats('txt'));
    toolbar.querySelector('.chm-native-batch-delete').addEventListener('click', () => void batchDeleteNativeChats());
    updateNativeBatchToolbar();
}

function nativeChatFileName(wrapper) {
    const blockName = wrapper.querySelector('.select_chat_block')?.getAttribute('file_name');
    const visibleName = wrapper.querySelector('.select_chat_block_filename')?.textContent;
    return chatName(blockName || visibleName);
}

function observeNativeChatManager() {
    const container = document.getElementById('select_chat_div');
    if (!container) return;
    nativeChatObserver ??= new MutationObserver(() => scheduleNativeChatGrouping());
    nativeChatObserver.observe(container, { childList: true, subtree: true });
}

function scheduleNativeChatGrouping() {
    clearTimeout(nativeGroupingTimer);
    const generation = ++nativeGroupingGeneration;
    nativeGroupingTimer = setTimeout(() => void applyNativeChatGrouping(generation), 60);
}

function resetNativeChatTree(wrapper) {
    wrapper.classList.remove('chm-native-branch');
    wrapper.style.removeProperty('--chm-native-indent');
    wrapper.querySelector('.chm-native-branch-badge')?.remove();
}

function decorateNativeChatTree(wrapper, node, depth) {
    resetNativeChatTree(wrapper);
    if (!node.parent) return;
    wrapper.classList.add('chm-native-branch');
    wrapper.style.setProperty('--chm-native-indent', `${Math.min(depth, 5) * 15}px`);
    const badge = document.createElement('span');
    badge.className = 'chm-native-branch-badge';
    badge.innerHTML = '<i class="fa-solid fa-code-branch" aria-hidden="true"></i><span>分支</span>';
    badge.title = `父聊天：${node.parent.chat.fileName}`;
    const filename = wrapper.querySelector('.select_chat_block_filename');
    filename?.before(badge);
}

function orderNativeTreeWrappers(roots, wrappersByName, usedWrappers) {
    const ordered = [];
    const visit = (node, visibleParentDepth = -1) => {
        const wrapper = wrappersByName.get(node.chat.fileName);
        let childParentDepth = visibleParentDepth;
        if (wrapper && !usedWrappers.has(wrapper)) {
            const depth = Math.max(0, visibleParentDepth + 1);
            decorateNativeChatTree(wrapper, node, depth);
            ordered.push(wrapper);
            usedWrappers.add(wrapper);
            childParentDepth = depth;
        }
        for (const child of node.children) visit(child, childParentDepth);
    };
    for (const root of roots) visit(root);
    return ordered;
}

function createNativeFolderSection(entry, folder, roots, wrappers) {
    const section = document.createElement('section');
    section.className = 'chm-native-folder-section';
    const collapseKey = `${entry.key}::${folder.id}`;
    if (settings().collapsedFolders[collapseKey]) section.classList.add('is-collapsed');
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'chm-native-folder-header';
    header.innerHTML = '<i class="fa-regular fa-folder" aria-hidden="true"></i>';
    const name = document.createElement('span');
    name.className = 'chm-native-folder-name';
    name.textContent = folder.name;
    const count = document.createElement('span');
    count.className = 'chm-native-folder-count';
    count.textContent = String(wrappers.length);
    const caret = document.createElement('i');
    caret.className = 'fa-solid fa-chevron-down chm-native-folder-caret';
    caret.setAttribute('aria-hidden', 'true');
    header.append(name, count, caret);
    header.setAttribute('aria-expanded', String(!section.classList.contains('is-collapsed')));
    header.title = `${folder.name} · ${roots.length} 个主聊天`;
    const list = document.createElement('div');
    list.className = 'chm-native-folder-list';
    list.append(...wrappers);
    header.addEventListener('click', event => {
        event.stopPropagation();
        const collapsed = section.classList.toggle('is-collapsed');
        header.setAttribute('aria-expanded', String(!collapsed));
        if (collapsed) settings().collapsedFolders[collapseKey] = true;
        else delete settings().collapsedFolders[collapseKey];
        saveSettings();
    });
    section.append(header, list);
    return section;
}

async function applyNativeChatGrouping(generation = nativeGroupingGeneration) {
    const container = document.getElementById('select_chat_div');
    if (!container) return;
    ensureNativeBatchToolbar();
    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId];
    const batchCharacterKey = character && !context.groupId ? characterKey(character) : '';
    if (batchCharacterKey !== nativeBatchCharacterKey) {
        nativeBatchCharacterKey = batchCharacterKey;
        nativeBatchMode = false;
        nativeSelectedChats.clear();
    }
    const batchToolbar = document.querySelector('.chm-native-batch-toolbar');
    if (batchToolbar) batchToolbar.hidden = !batchCharacterKey || !nativeBatchMode;
    const batchToggle = document.querySelector('.chm-native-batch-toggle');
    if (batchToggle) batchToggle.hidden = !batchCharacterKey;
    let entry = character && getCachedCharacter(characterKey(character));
    if (character && !entry) {
        entry = await loadCharacterEntry({
            id: String(context.characterId),
            character,
            key: characterKey(character),
        });
    }
    if (generation !== nativeGroupingGeneration) return;

    nativeChatObserver?.disconnect();
    try {
        const wrappers = Array.from(container.querySelectorAll('.select_chat_block_wrapper'));
        container.replaceChildren(...wrappers);
        const nativeQuery = document.getElementById('select_chat_search')?.value.trim() || '';
        if (!nativeQuery) {
            const availableNames = new Set(wrappers.map(nativeChatFileName));
            for (const name of nativeSelectedChats) {
                if (!availableNames.has(name)) nativeSelectedChats.delete(name);
            }
        }
        wrappers.forEach(attachNativeBatchCheckbox);
        wrappers.forEach(resetNativeChatTree);
        updateNativeBatchToolbar();
        if (!entry || context.groupId || !wrappers.length) return;
        const library = getLibrary(entry.key);
        const wrappersByName = new Map(wrappers.map(wrapper => [nativeChatFileName(wrapper), wrapper]));
        const usedWrappers = new Set();
        const rootsByFolder = new Map(library.folders.map(folder => [folder.id, []]));
        const unfiledRoots = [];
        const allRoots = buildChatTree(entry.chats);
        for (const root of allRoots) {
            const folderId = library.chatFolders[root.chat.fileName];
            if (folderId && rootsByFolder.has(folderId)) rootsByFolder.get(folderId).push(root);
            else unfiledRoots.push(root);
        }
        if (!library.folders.length) {
            const ordered = orderNativeTreeWrappers(allRoots, wrappersByName, usedWrappers);
            const unmatched = wrappers.filter(wrapper => !usedWrappers.has(wrapper));
            container.replaceChildren(...ordered, ...unmatched);
            return;
        }

        const blocks = library.folders
            .map(folder => {
                const roots = rootsByFolder.get(folder.id);
                return { folder, roots, wrappers: orderNativeTreeWrappers(roots, wrappersByName, usedWrappers) };
            })
            .filter(block => block.wrappers.length);
        const unfiledWrappers = orderNativeTreeWrappers(unfiledRoots, wrappersByName, usedWrappers);
        unfiledWrappers.push(...wrappers.filter(wrapper => !usedWrappers.has(wrapper)));
        if (unfiledWrappers.length) blocks.push({ folder: null, roots: unfiledRoots, wrappers: unfiledWrappers });
        blocks.sort((a, b) => (
            rootsLatestTimestamp(b.roots) - rootsLatestTimestamp(a.roots)
            || (a.folder?.name || '').localeCompare(b.folder?.name || '')
        ));

        const fragment = document.createDocumentFragment();
        for (const block of blocks) {
            if (block.folder) fragment.append(createNativeFolderSection(entry, block.folder, block.roots, block.wrappers));
            else fragment.append(...block.wrappers);
        }
        container.replaceChildren(fragment);
    } finally {
        observeNativeChatManager();
    }
}

function registerEvents() {
    let refreshTimer = null;
    let invalidateAll = false;
    const invalidationKeys = new Set();
    const scheduleRefresh = ({ invalidate = false, characterKeyValue = '' } = {}) => {
        if (invalidate) {
            if (characterKeyValue) invalidationKeys.add(characterKeyValue);
            else invalidateAll = true;
        }
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            if (invalidateAll) invalidateCharacterCache();
            else invalidationKeys.forEach(invalidateCharacterCache);
            invalidateAll = false;
            invalidationKeys.clear();
            if (chatsPanel && !chatsPanel.hidden) void refreshChats();
            scheduleNativeChatGrouping();
        }, 180);
    };
    if (event_types.CHAT_CHANGED) {
        SillyTavern.getContext().eventSource?.on(event_types.CHAT_CHANGED, () => {
            browseAllCharacters = false;
            const activeKey = getActiveCharacterKey();
            const cached = activeKey ? getCachedCharacter(activeKey) : null;
            const currentExists = cached?.chats.some(chat => chat.fileName === currentChatName());
            scheduleRefresh({ invalidate: Boolean(activeKey && !currentExists), characterKeyValue: activeKey });
            void validateBackToParentButton();
        });
    }
    for (const type of [event_types.CHARACTER_RENAMED, event_types.CHARACTER_DELETED]) {
        if (type) SillyTavern.getContext().eventSource?.on(type, () => scheduleRefresh({ invalidate: true }));
    }
    if (event_types.CHARACTER_PAGE_LOADED) {
        SillyTavern.getContext().eventSource?.on(event_types.CHARACTER_PAGE_LOADED, () => scheduleRefresh());
    }
}

function init() {
    settings();
    if (!installTabs()) {
        setTimeout(installTabs, 500);
    }
    registerEvents();
    ensureNativeBatchToolbar();
    observeNativeChatManager();
    scheduleNativeChatGrouping();
    document.getElementById('options_button')?.addEventListener('click', () => void validateBackToParentButton());
    void validateBackToParentButton();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
