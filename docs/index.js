(function () {
function require(id) {
  switch (id) {
    case "@vendetta": return vendetta;
    case "@vendetta/metro": return vendetta.metro;
    case "@vendetta/metro/common": return vendetta.metro.common;
    case "@vendetta/ui/assets": return vendetta.ui.assets;
    case "@vendetta/ui/toasts": return vendetta.ui.toasts;
    case "@vendetta/ui/components": return vendetta.ui.components;
    case "@vendetta/storage": return vendetta.storage;
    case "@vendetta/plugin": return vendetta.plugin;
    default: throw new Error("[ThreadFileDeleter] Unknown module: " + id);
  }
}
var module = { exports: {} };
var exports = module.exports;
'use strict';

Object.defineProperties(exports, { __esModule: { value: true }, [Symbol.toStringTag]: { value: 'Module' } });

const metro = require('@vendetta/metro');
const plugin = require('@vendetta/plugin');
const _vendetta = require('@vendetta');
const common = require('@vendetta/metro/common');
const assets = require('@vendetta/ui/assets');
const toasts = require('@vendetta/ui/toasts');
const components = require('@vendetta/ui/components');
const storage = require('@vendetta/storage');

const { FormSection, FormInput, FormText, FormSwitchRow } = components.Forms;

const threadCache = new Map();
const THREAD_TYPES = [10, 11, 12];
const GDRIVE_RE = /https?:\/\/(drive|docs)\.google\.com\/\S+/i;

function Settings() {
  storage.useProxy(plugin.storage);
  const h = common.React.createElement;
  return h(
    FormSection,
    { title: "Thread File Deleter", android_noDivider: true },
    h(FormInput, {
      title: "Blacklisted users",
      placeholder: "User IDs or usernames, separated by commas",
      value: plugin.storage.blacklist,
      onChange: (v) => {
        plugin.storage.blacklist = v;
        threadCache.clear();
      }
    }),
    h(FormInput, {
      title: "Thread channel ID (optional)",
      placeholder: "Channel where threads are created",
      value: plugin.storage.threadChannelId,
      onChange: (v) => {
        plugin.storage.threadChannelId = v.trim();
        threadCache.clear();
      }
    }),
    FormSwitchRow
      ? h(FormSwitchRow, {
          label: "Test mode (don't delete, only show a toast)",
          value: !!plugin.storage.dryRun,
          onValueChange: (v) => (plugin.storage.dryRun = v)
        })
      : null,
    h(
      FormText,
      { style: { paddingHorizontal: 16, paddingBottom: 8 } },
      "Deletes messages containing Google Drive links or file attachments inside threads that belong to a blacklisted user. " +
        "Username (with or without @): matches threads whose name is exactly that username. " +
        "User ID: matches threads owned by that user, and also their cached username against thread names. " +
        "If you set a thread channel ID, only threads in that channel are checked. " +
        "You need the Manage Messages permission. Enable Developer Mode, then long-press a user and use Copy User ID."
    )
  );
}

const norm = (s) => String(s != null ? s : "").toLowerCase();
const clean = (s) => norm(s).replace(/[^a-z0-9\u00C0-\uFFFF]/g, "");
const isId = (s) => /^\d{15,25}$/.test(s);

function getRest() {
  return metro.findByProps("get", "post", "del", "patch");
}

let channelStore = null;
function getChannel(channelId) {
  try {
    if (!channelStore) {
      channelStore = metro.findByProps("getChannel", "getMutableGuildChannelsForGuild");
    }
    return channelStore && channelStore.getChannel ? channelStore.getChannel(channelId) : null;
  } catch (e) {
    _vendetta.logger.log("[ThreadFileDeleter] channel lookup failed: " + String(e));
    return null;
  }
}

function toast(text) {
  try {
    toasts.showToast(text, assets.getAssetIDByName("Small"));
  } catch (e) {
    _vendetta.logger.log("[ThreadFileDeleter] toast failed: " + String(e));
  }
}

function getEntries() {
  return String(plugin.storage.blacklist != null ? plugin.storage.blacklist : "")
    .split(/[,;\n]+/)
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);
}

// True when the thread belongs to a blacklisted user
function isBlacklistedThread(ch) {
  if (!ch || THREAD_TYPES.indexOf(ch.type) === -1) return false;

  const entries = getEntries();
  if (!entries.length) return false;

  const parentId = ch.parent_id != null ? ch.parent_id : ch.parentId;
  const ownerId = ch.owner_id != null ? ch.owner_id : ch.ownerId;
  const channelFilter = plugin.storage.threadChannelId;

  if (channelFilter && parentId !== channelFilter) return false;

  const ids = entries.filter(isId);
  if (ownerId && ids.indexOf(ownerId) !== -1) return true;

  const names = new Set(entries.filter((e) => !isId(e)).map(clean).filter((n) => n.length >= 2));
  try {
    const UserStore = metro.findByProps("getUser", "getCurrentUser");
    for (const id of ids) {
      const u = UserStore && UserStore.getUser ? UserStore.getUser(id) : null;
      if (u) {
        [u.username, u.globalName, u.global_name]
          .map(clean)
          .filter((n) => n.length >= 3)
          .forEach((n) => names.add(n));
      }
    }
  } catch (e) {
    _vendetta.logger.log("[ThreadFileDeleter] user lookup failed: " + String(e));
  }

  const threadName = clean(ch.name);
  return !!(threadName && names.has(threadName));
}

function isCachedBlacklistedThread(channelId) {
  if (threadCache.has(channelId)) return threadCache.get(channelId);
  const ch = getChannel(channelId);
  if (!ch) return false;
  const result = isBlacklistedThread(ch);
  threadCache.set(channelId, result);
  return result;
}

// Returns a reason string if the message has a file or Drive link, otherwise null
function offendingReason(msg) {
  if (msg.attachments && msg.attachments.length > 0) return "attachment";
  if (msg.content && GDRIVE_RE.test(msg.content)) return "Google Drive link";
  if (msg.embeds && msg.embeds.length > 0) {
    for (let i = 0; i < msg.embeds.length; i++) {
      const e = msg.embeds[i];
      if (e && e.url && GDRIVE_RE.test(e.url)) return "Google Drive link";
    }
  }
  return null;
}

async function removeMessage(channelId, messageId, reason) {
  const label = channelId + "/" + messageId;
  if (plugin.storage.dryRun) {
    _vendetta.logger.log("[ThreadFileDeleter] TEST MODE: would delete " + label + " (" + reason + ")");
    toast("Test mode: would delete message (" + reason + ")");
    return;
  }
  try {
    await getRest().del({ url: "/channels/" + channelId + "/messages/" + messageId });
    _vendetta.logger.log("[ThreadFileDeleter] Deleted " + label + " (" + reason + ")");
    toast("Deleted message: " + reason);
  } catch (e) {
    const status = e && (e.status != null ? e.status : e.response && e.response.status);
    _vendetta.logger.log("[ThreadFileDeleter] Delete failed (" + status + "): " + String(e && (e.message || (e.body && e.body.message))));
    toast(status === 403 ? "Can't delete message, missing Manage Messages permission" : "Failed to delete message");
  }
}

function onMessageCreate(ev) {
  try {
    if (!ev || ev.optimistic) return;
    const msg = ev.message;
    if (!msg || !msg.id) return;
    const channelId = ev.channelId || msg.channel_id;
    if (!channelId) return;

    const reason = offendingReason(msg);
    if (!reason) return;
    if (!isCachedBlacklistedThread(channelId)) return;

    removeMessage(channelId, msg.id, reason);
  } catch (e) {
    _vendetta.logger.log("[ThreadFileDeleter] handler error: " + String(e));
  }
}

function onThreadChange(ev) {
  try {
    const ch = ev && ev.channel;
    if (ch && ch.id) threadCache.delete(ch.id);
  } catch (e) {}
}

const index = {
  onLoad() {
    if (plugin.storage.blacklist == null) plugin.storage.blacklist = "";
    if (plugin.storage.threadChannelId == null) plugin.storage.threadChannelId = "";
    if (plugin.storage.dryRun == null) plugin.storage.dryRun = false;
    threadCache.clear();
    common.FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    common.FluxDispatcher.subscribe("THREAD_CREATE", onThreadChange);
    common.FluxDispatcher.subscribe("THREAD_UPDATE", onThreadChange);
    _vendetta.logger.log("[ThreadFileDeleter] Loaded.");
  },
  onUnload() {
    common.FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
    common.FluxDispatcher.unsubscribe("THREAD_CREATE", onThreadChange);
    common.FluxDispatcher.unsubscribe("THREAD_UPDATE", onThreadChange);
    threadCache.clear();
    _vendetta.logger.log("[ThreadFileDeleter] Unloaded.");
  },
  settings: Settings
};

exports.default = index;
return module.exports;
})();
