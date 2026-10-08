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

function Settings() {
  storage.useProxy(plugin.storage);
  const h = common.React.createElement;
  return h(
    FormSection,
    { title: "Thread File Deleter", android_noDivider: true },
    h(FormInput, {
      title: "Blacklisted users",
      placeholder: "User IDs or usernames, comma-separated",
      value: plugin.storage.blacklist,
      onChange: (v) => (plugin.storage.blacklist = v)
    }),
    h(FormInput, {
      title: "Thread channel ID",
      placeholder: "Parent channel where user threads live",
      value: plugin.storage.threadChannelId,
      onChange: (v) => (plugin.storage.threadChannelId = v.trim())
    }),
    FormSwitchRow
      ? h(FormSwitchRow, {
          label: "Test mode (log but don't delete)",
          value: !!plugin.storage.dryRun,
          onValueChange: (v) => (plugin.storage.dryRun = v)
        })
      : null,
    h(
      FormText,
      { style: { paddingHorizontal: 16, paddingBottom: 8 } },
      "Deletes messages with Google Drive links or file attachments in threads named after blacklisted users. " +
      "Set Thread channel ID to the parent forum/channel. You need Manage Messages permission."
    )
  );
}

const norm  = (s) => String(s != null ? s : "").toLowerCase();
const clean = (s) => norm(s).replace(/[^a-z0-9À-￿]/g, "");
const isId  = (s) => /^\d{15,25}$/.test(s);

// Matches bare or markdown-linked Google Drive / Docs URLs
// Strips trailing punctuation like ) ] > that may close a markdown link
const GDRIVE_RE = /https?:\/\/(drive|docs)\.google\.com\/[^\s\)\]>]*/i;

const THREAD_TYPES = [10, 11, 12];

function getRest() {
  return metro.findByProps("get", "post", "del", "patch");
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

function buildNameSet(entries) {
  const names = new Set(
    entries.filter((e) => !isId(e)).map(clean).filter((n) => n.length >= 2)
  );
  const ids = entries.filter(isId);
  if (ids.length) {
    try {
      const UserStore = metro.findByProps("getUser", "getCurrentUser");
      for (const id of ids) {
        const u = UserStore && UserStore.getUser ? UserStore.getUser(id) : null;
        if (u) {
          [u.username, u.globalName, u.global_name]
            .filter(Boolean)
            .map(clean)
            .filter((n) => n.length >= 3)
            .forEach((n) => names.add(n));
        }
      }
    } catch (e) {
      _vendetta.logger.log("[ThreadFileDeleter] user lookup failed: " + String(e));
    }
  }
  return names;
}

function isBlacklistedThread(ch) {
  if (!ch) return false;
  if (!THREAD_TYPES.includes(ch.type)) return false;
  const channelFilter = plugin.storage.threadChannelId;
  const parentId = ch.parent_id != null ? ch.parent_id : ch.parentId;
  if (channelFilter && parentId !== channelFilter) return false;
  const entries = getEntries();
  if (!entries.length) return false;
  const names = buildNameSet(entries);
  const threadName = clean(ch.name || "");
  return !!(threadName && names.has(threadName));
}

// Check a string (content, embed field, etc.) for a Drive link
function hasDriveLink(str) {
  return str != null && GDRIVE_RE.test(String(str));
}

function hasOffendingContent(msg) {
  // File/image attachments
  if (msg.attachments && msg.attachments.length > 0) return "attachment";

  // Check embeds — including rich embeds whose url/description contain a Drive link
  if (msg.embeds && msg.embeds.length > 0) {
    for (const e of msg.embeds) {
      if (e.type && e.type !== "rich") return "embedded file";
      if (hasDriveLink(e.url)) return "Google Drive link";
      if (hasDriveLink(e.description)) return "Google Drive link";
      if (e.title && hasDriveLink(e.title)) return "Google Drive link";
      if (e.fields && e.fields.length > 0) {
        for (const f of e.fields) {
          if (hasDriveLink(f.value) || hasDriveLink(f.name)) return "Google Drive link";
        }
      }
    }
  }

  // Check message content — handles bare URLs and markdown [text](url) links
  if (msg.content && hasDriveLink(msg.content)) return "Google Drive link";

  return null;
}

const threadCache = new Map();

function getChannelFromStore(channelId) {
  try {
    const ChannelStore = metro.findByProps("getChannel", "getMutableGuildChannelsForGuild");
    return ChannelStore && ChannelStore.getChannel ? ChannelStore.getChannel(channelId) : null;
  } catch (e) {
    return null;
  }
}

function isCachedBlacklistedThread(channelId) {
  if (threadCache.has(channelId)) return threadCache.get(channelId);
  const ch = getChannelFromStore(channelId);
  if (!ch) return false;
  const result = isBlacklistedThread(ch);
  threadCache.set(channelId, result);
  return result;
}

async function deleteMessage(channelId, messageId, reason) {
  const label = channelId + "/" + messageId;
  if (plugin.storage.dryRun) {
    _vendetta.logger.log("[ThreadFileDeleter] TEST: would delete " + label + " (" + reason + ")");
    toast("Test mode: would delete message in thread");
    return;
  }
  try {
    await getRest().del({ url: "/channels/" + channelId + "/messages/" + messageId });
    _vendetta.logger.log("[ThreadFileDeleter] Deleted " + label + " (" + reason + ")");
    toast("Deleted message with " + reason);
  } catch (e) {
    const status = e && (e.status != null ? e.status : e.response && e.response.status);
    _vendetta.logger.log(
      "[ThreadFileDeleter] Delete failed (" + status + "): " +
      String(e && (e.message || (e.body && e.body.message)))
    );
    toast(
      status === 403
        ? "Can't delete message, missing Manage Messages permission"
        : "Failed to delete message"
    );
  }
}

function onMessageCreate(ev) {
  try {
    const msg = ev && ev.message;
    if (!msg || !msg.id) return;
    const channelId = (ev && ev.channelId) || msg.channel_id;
    if (!channelId) return;
    if (!isCachedBlacklistedThread(channelId)) return;
    const reason = hasOffendingContent(msg);
    if (!reason) return;
    deleteMessage(channelId, msg.id, reason);
  } catch (e) {
    _vendetta.logger.log("[ThreadFileDeleter] handler error: " + String(e));
  }
}

function onChannelUpdate(ev) {
  try {
    const ch = ev && (ev.channel || ev.Channel);
    if (ch && ch.id) threadCache.delete(ch.id);
  } catch (e) {}
}

const index = {
  onLoad() {
    if (plugin.storage.blacklist == null)       plugin.storage.blacklist = "";
    if (plugin.storage.threadChannelId == null) plugin.storage.threadChannelId = "";
    if (plugin.storage.dryRun == null)          plugin.storage.dryRun = false;
    threadCache.clear();
    common.FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    common.FluxDispatcher.subscribe("CHANNEL_UPDATE", onChannelUpdate);
    common.FluxDispatcher.subscribe("CHANNEL_CREATE", onChannelUpdate);
    _vendetta.logger.log("[ThreadFileDeleter] Loaded.");
  },
  onUnload() {
    common.FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
    common.FluxDispatcher.unsubscribe("CHANNEL_UPDATE", onChannelUpdate);
    common.FluxDispatcher.unsubscribe("CHANNEL_CREATE", onChannelUpdate);
    threadCache.clear();
    _vendetta.logger.log("[ThreadFileDeleter] Unloaded.");
  },
  settings: Settings
};

exports.default = index;
return module.exports;
})();
