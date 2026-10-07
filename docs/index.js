(function () {
  'use strict';

  const vd = window.vendetta;
  const { findByProps, findByStoreName } = vd.metro;

  const React = findByProps("createElement", "useState");
  const RN = findByProps("View", "Text", "StyleSheet");
  const { createElement: h, useState } = React;
  const { View, Text, TextInput, ScrollView, Switch, StyleSheet, TouchableOpacity } = RN;

  const HTTP = findByProps("put", "del", "patch", "post", "get", "getAPIBaseURL");
  const FD = findByProps("_interceptors");
  const ChannelStore = findByStoreName("ChannelStore");
  const UserStore = findByStoreName("UserStore");
  const ThemeStore = findByStoreName("ThemeStore");
  const tokens = findByProps("unsafe_rawColors", "colors");

  const { createStorage, wrapSync, createMMKVBackend } = vd.storage;
  const storage = wrapSync(createStorage(createMMKVBackend("ThreadFileDeleter")));

  // -------------------------------------------------------------------------
  // Storage helpers
  // -------------------------------------------------------------------------

  function getBlacklist() {
    if (!storage["blacklist"]) storage["blacklist"] = "";
    return storage["blacklist"];
  }

  function getThreadChannelId() {
    if (!storage["threadChannelId"]) storage["threadChannelId"] = "";
    return storage["threadChannelId"];
  }

  function isDryRun() {
    return !!storage["dryRun"];
  }

  // -------------------------------------------------------------------------
  // Color helper (same pattern as autoreactor)
  // -------------------------------------------------------------------------

  function c(key, fallback) {
    try {
      const t = tokens;
      const sc = t && t.colors && t.colors[key];
      const resolve = t && t.internal && t.internal.resolveSemanticColor;
      if (sc && resolve) {
        const out = resolve(ThemeStore && ThemeStore.theme, sc);
        if (typeof out === "string" && out) return out;
      }
    } catch (e) { /* fall through */ }
    return fallback;
  }

  // -------------------------------------------------------------------------
  // Matching helpers
  // -------------------------------------------------------------------------

  const norm  = function(s) { return String(s != null ? s : "").toLowerCase(); };
  const clean = function(s) { return norm(s).replace(/[^a-z0-9\u00C0-\uFFFF]/g, ""); };
  const isId  = function(s) { return /^\d{15,25}$/.test(s); };

  const GDRIVE_RE = /https?:\/\/(drive|docs)\.google\.com\/\S+/i;

  function getEntries() {
    return String(getBlacklist())
      .split(/[,;\n]+/)
      .map(function(s) { return s.trim().replace(/^@/, ""); })
      .filter(Boolean);
  }

  function buildNameSet(entries) {
    const names = new Set(
      entries.filter(function(e) { return !isId(e); }).map(clean).filter(function(n) { return n.length >= 2; })
    );
    const ids = entries.filter(isId);
    if (ids.length) {
      try {
        for (let i = 0; i < ids.length; i++) {
          const u = UserStore && UserStore.getUser && UserStore.getUser(ids[i]);
          if (u) {
            [u.username, u.globalName, u.global_name]
              .map(clean)
              .filter(function(n) { return n.length >= 3; })
              .forEach(function(n) { names.add(n); });
          }
        }
      } catch (e) { /* ignore */ }
    }
    return names;
  }

  // Thread type constants
  const THREAD_TYPES = [10, 11, 12];

  // Cache channel results so we don't re-check on every message
  const threadCache = new Map();

  function isBlacklistedThread(channelId) {
    if (threadCache.has(channelId)) return threadCache.get(channelId);

    const ch = ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(channelId);
    if (!ch) { threadCache.set(channelId, false); return false; }

    // Must be a thread
    if (THREAD_TYPES.indexOf(ch.type) === -1) { threadCache.set(channelId, false); return false; }

    // Must be under the configured parent channel (if set)
    const parentFilter = getThreadChannelId();
    const parentId = ch.parent_id != null ? ch.parent_id : ch.parentId;
    if (parentFilter && parentId !== parentFilter) { threadCache.set(channelId, false); return false; }

    const entries = getEntries();
    if (!entries.length) { threadCache.set(channelId, false); return false; }

    const names = buildNameSet(entries);
    const threadName = clean(ch.name);
    const result = !!(threadName && names.has(threadName));
    threadCache.set(channelId, result);
    return result;
  }

  function hasOffendingContent(msg) {
    if (msg.attachments && msg.attachments.length > 0) return true;
    if (msg.embeds && msg.embeds.length > 0) {
      for (let i = 0; i < msg.embeds.length; i++) {
        const e = msg.embeds[i];
        if (e.type && e.type !== "rich") return true;
        if (e.url && GDRIVE_RE.test(e.url)) return true;
      }
    }
    if (msg.content && GDRIVE_RE.test(msg.content)) return true;
    return false;
  }

  function getOffendingReason(msg) {
    if (msg.attachments && msg.attachments.length > 0) return "attachment";
    if (msg.content && GDRIVE_RE.test(msg.content)) return "Google Drive link";
    return "embedded file";
  }

  // -------------------------------------------------------------------------
  // REST delete
  // -------------------------------------------------------------------------

  function deleteMessage(channelId, messageId, reason) {
    if (isDryRun()) {
      console.log("[ThreadFileDeleter] TEST: would delete " + channelId + "/" + messageId + " (" + reason + ")");
      return;
    }
    try {
      HTTP.del({ url: "/channels/" + channelId + "/messages/" + messageId });
      console.log("[ThreadFileDeleter] Deleted " + channelId + "/" + messageId + " (" + reason + ")");
    } catch (e) {
      console.log("[ThreadFileDeleter] Delete failed: " + String(e && (e.message || e)));
    }
  }

  // -------------------------------------------------------------------------
  // Interceptor (same mechanism as autoreactor)
  // -------------------------------------------------------------------------

  let interceptFn = null;

  // -------------------------------------------------------------------------
  // Settings UI
  // -------------------------------------------------------------------------

  const S = StyleSheet.create({
    container: { flex: 1 },
    content: { padding: 16, paddingBottom: 80 },
    title: { fontSize: 20, fontWeight: "800", marginBottom: 4 },
    subtitle: { fontSize: 13, lineHeight: 18, marginBottom: 20, opacity: 0.6 },
    label: { fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.55, marginBottom: 6, marginTop: 14 },
    input: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, borderWidth: 1, marginBottom: 2 },
    hint: { fontSize: 12, opacity: 0.5, marginTop: 4, lineHeight: 16 },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18 },
    rowLabel: { fontSize: 15, flex: 1 },
  });

  function Settings() {
    const [blacklist, setBlacklist]         = useState(getBlacklist);
    const [threadChannelId, setThreadChannelId] = useState(getThreadChannelId);
    const [dryRun, setDryRun]               = useState(isDryRun);

    const inputStyle = [S.input, {
      color: c("TEXT_NORMAL", "#fff"),
      backgroundColor: c("INPUT_BACKGROUND", "#1e1f22"),
      borderColor: c("BORDER_SUBTLE", "#3f4147"),
    }];

    function saveBlacklist(v) {
      setBlacklist(v);
      storage["blacklist"] = v;
      threadCache.clear();
    }
    function saveThreadChannelId(v) {
      setThreadChannelId(v);
      storage["threadChannelId"] = v.trim();
      threadCache.clear();
    }
    function saveDryRun(v) {
      setDryRun(v);
      storage["dryRun"] = v;
    }

    return h(ScrollView,
      { style: [S.container, { backgroundColor: c("BACKGROUND_PRIMARY", "#313338") }], contentContainerStyle: S.content },

      h(Text, { style: [S.title, { color: c("HEADER_PRIMARY", "#fff") }] }, "Thread File Deleter"),
      h(Text, { style: [S.subtitle, { color: c("TEXT_MUTED", "#949ba4") }] },
        "Deletes messages with Google Drive links or file attachments posted in threads named after blacklisted users."),

      h(Text, { style: [S.label, { color: c("TEXT_NORMAL", "#dbdee1") }] }, "Blacklisted users"),
      h(TextInput, {
        style: inputStyle,
        value: blacklist,
        onChangeText: saveBlacklist,
        placeholder: "User IDs or @usernames, comma separated",
        placeholderTextColor: c("TEXT_MUTED", "#87898c"),
        multiline: true,
      }),
      h(Text, { style: [S.hint, { color: c("TEXT_MUTED", "#949ba4") }] },
        "e.g. cooluser, 123456789012345678. The thread just needs to be named after them — they don't have to own it."),

      h(Text, { style: [S.label, { color: c("TEXT_NORMAL", "#dbdee1") }] }, "Thread channel ID"),
      h(TextInput, {
        style: inputStyle,
        value: threadChannelId,
        onChangeText: saveThreadChannelId,
        placeholder: "Parent forum/channel ID",
        placeholderTextColor: c("TEXT_MUTED", "#87898c"),
        keyboardType: "numeric",
      }),
      h(Text, { style: [S.hint, { color: c("TEXT_MUTED", "#949ba4") }] },
        "Only threads inside this channel are checked. Enable Developer Mode, long-press the channel → Copy Channel ID."),

      h(View, { style: S.row },
        h(Text, { style: [S.rowLabel, { color: c("TEXT_NORMAL", "#dbdee1") }] }, "Test mode (log, don't delete)"),
        h(Switch, {
          value: dryRun,
          onValueChange: saveDryRun,
          trackColor: { true: c("BRAND_500", "#5865f2"), false: c("BACKGROUND_TERTIARY", "#1e1f22") },
        }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Plugin export
  // -------------------------------------------------------------------------

  return {
    onLoad: function() {
      threadCache.clear();
      interceptFn = function(payload) {
        if (payload.type !== "MESSAGE_CREATE" || payload.optimistic) return null;
        const msg = payload.message;
        if (!msg || !msg.id) return null;
        const channelId = payload.channelId || msg.channel_id;
        if (!channelId) return null;
        if (!isBlacklistedThread(channelId)) return null;
        if (!hasOffendingContent(msg)) return null;
        deleteMessage(channelId, msg.id, getOffendingReason(msg));
        return null;
      };
      FD._interceptors.push(interceptFn);
      console.log("[ThreadFileDeleter] Loaded.");
    },
    onUnload: function() {
      if (interceptFn) {
        FD._interceptors = FD._interceptors.filter(function(f) { return f !== interceptFn; });
        interceptFn = null;
      }
      threadCache.clear();
      console.log("[ThreadFileDeleter] Unloaded.");
    },
    settings: Settings,
  };
})();
