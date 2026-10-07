(function () {
    'use strict';

    const vd = window.vendetta;
    const { findByProps, findByStoreName } = vd.metro;

    const FD         = findByProps("_interceptors");
    const HTTP       = findByProps("put", "del", "patch", "post", "get", "getAPIBaseURL");
    const TokenStore = findByStoreName("UserAuthTokenStore") || findByStoreName("AuthenticationStore");
    const ChannelStore = findByStoreName("ChannelStore");
    const UserStore  = findByStoreName("UserStore");

    const React = findByProps("createElement", "useState");
    const RN    = findByProps("View", "Text", "StyleSheet");
    const { createElement: h, useState } = React;
    const { View, Text, TextInput, ScrollView, Switch, StyleSheet, TouchableOpacity } = RN;

    const tokens     = findByProps("unsafe_rawColors", "colors");
    const ThemeStore = findByStoreName("ThemeStore");

    // -------------------------------------------------------------------------
    // Storage (MMKV-backed, same pattern as autoreactor)
    // -------------------------------------------------------------------------

    const { createStorage, wrapSync, createMMKVBackend } = vd.storage;
    const storage = wrapSync(createStorage(createMMKVBackend("ThreadFileDeleter")));

    function getBlacklist() {
        if (!storage["blacklist"]) storage["blacklist"] = "";
        return storage["blacklist"];
    }
    function setBlacklist(v) { storage["blacklist"] = v; }

    function getThreadChannelId() {
        if (storage["threadChannelId"] == null) storage["threadChannelId"] = "";
        return storage["threadChannelId"];
    }
    function setThreadChannelId(v) { storage["threadChannelId"] = v; }

    function getDryRun() {
        if (storage["dryRun"] == null) storage["dryRun"] = false;
        return !!storage["dryRun"];
    }
    function setDryRun(v) { storage["dryRun"] = v; }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    const API_BASE = "https://discord.com/api/v9";

    function getToken() {
        return TokenStore.getToken ? TokenStore.getToken() : TokenStore.token;
    }

    function c(key, fallback) {
        try {
            const t = tokens;
            const sc = t && t.colors && t.colors[key];
            const resolve = t && t.internal && t.internal.resolveSemanticColor;
            if (sc && resolve) {
                const out = resolve(ThemeStore && ThemeStore.theme, sc);
                if (typeof out === "string" && out) return out;
            }
        } catch (e) {}
        return fallback;
    }

    const norm  = (s) => String(s != null ? s : "").toLowerCase();
    const clean = (s) => norm(s).replace(/[^a-z0-9\u00C0-\uFFFF]/g, "");
    const isId  = (s) => /^\d{15,25}$/.test(s);

    // Google Drive / Docs link
    const GDRIVE_RE = /https?:\/\/(drive|docs)\.google\.com\/\S+/i;

    // Thread channel types
    const THREAD_TYPES = [10, 11, 12];

    // -------------------------------------------------------------------------
    // Blacklist parsing
    // -------------------------------------------------------------------------

    function getEntries() {
        return String(getBlacklist())
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
                for (const id of ids) {
                    const u = UserStore && UserStore.getUser && UserStore.getUser(id);
                    if (u) {
                        [u.username, u.globalName, u.global_name]
                            .filter(Boolean)
                            .map(clean)
                            .filter((n) => n.length >= 3)
                            .forEach((n) => names.add(n));
                    }
                }
            } catch (e) {}
        }
        return names;
    }

    // -------------------------------------------------------------------------
    // Thread cache
    // -------------------------------------------------------------------------

    const threadCache = new Map();

    function getChannelObj(channelId) {
        try {
            return ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(channelId);
        } catch (e) {
            return null;
        }
    }

    function isBlacklistedThread(ch) {
        if (!ch) return false;
        if (!THREAD_TYPES.includes(ch.type)) return false;
        const channelFilter = getThreadChannelId();
        const parentId = ch.parent_id != null ? ch.parent_id : ch.parentId;
        if (channelFilter && parentId !== channelFilter) return false;
        const entries = getEntries();
        if (!entries.length) return false;
        const names = buildNameSet(entries);
        const threadName = clean(ch.name || "");
        return !!(threadName && names.has(threadName));
    }

    function isCachedBlacklistedThread(channelId) {
        if (threadCache.has(channelId)) return threadCache.get(channelId);
        const ch = getChannelObj(channelId);
        if (!ch) return false;
        const result = isBlacklistedThread(ch);
        threadCache.set(channelId, result);
        return result;
    }

    // -------------------------------------------------------------------------
    // Content check
    // -------------------------------------------------------------------------

    function hasOffendingContent(msg) {
        if (msg.attachments && msg.attachments.length > 0) return { reason: "attachment" };
        if (msg.embeds && msg.embeds.length > 0) {
            for (const e of msg.embeds) {
                if (e.type && e.type !== "rich") return { reason: "embedded file" };
                if (e.url && GDRIVE_RE.test(e.url)) return { reason: "Google Drive link" };
            }
        }
        if (msg.content && GDRIVE_RE.test(msg.content)) return { reason: "Google Drive link" };
        return null;
    }

    // -------------------------------------------------------------------------
    // Delete
    // -------------------------------------------------------------------------

    async function deleteMessage(channelId, messageId, reason) {
        if (getDryRun()) {
            console.log("[ThreadFileDeleter] TEST: would delete " + channelId + "/" + messageId + " (" + reason + ")");
            return;
        }
        try {
            await HTTP.del({
                url: API_BASE + "/channels/" + channelId + "/messages/" + messageId,
                headers: { Authorization: getToken() }
            });
            console.log("[ThreadFileDeleter] Deleted " + channelId + "/" + messageId + " (" + reason + ")");
        } catch (e) {
            const status = e && (e.status != null ? e.status : e.response && e.response.status);
            console.log("[ThreadFileDeleter] Delete failed (" + status + "): " + String(e && (e.message || (e.body && e.body.message))));
        }
    }

    // -------------------------------------------------------------------------
    // Styles
    // -------------------------------------------------------------------------

    const S = StyleSheet.create({
        container:   { flex: 1 },
        content:     { padding: 16, paddingBottom: 80 },
        title:       { fontSize: 20, fontWeight: "800", marginBottom: 4 },
        subtitle:    { fontSize: 13, opacity: 0.6, marginBottom: 16, lineHeight: 18 },
        label:       { fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.55, marginBottom: 6, marginTop: 14 },
        input:       { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, borderWidth: 1 },
        hint:        { fontSize: 12, opacity: 0.5, marginTop: 6, lineHeight: 16 },
        row:         { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1 },
        rowLabel:    { fontSize: 15, flex: 1 },
    });

    // -------------------------------------------------------------------------
    // Settings UI
    // -------------------------------------------------------------------------

    function Settings() {
        const [bl,   setBl]   = useState(getBlacklist());
        const [ch,   setCh]   = useState(getThreadChannelId());
        const [dry,  setDry]  = useState(getDryRun());

        const inputStyle = [
            S.input,
            {
                color:           c("TEXT_NORMAL",      "#dbdee1"),
                backgroundColor: c("INPUT_BACKGROUND", "#1e1f22"),
                borderColor:     c("BORDER_SUBTLE",    "#3f4147"),
            }
        ];

        return h(ScrollView,
            {
                style:                [S.container, { backgroundColor: c("BACKGROUND_PRIMARY", "#313338") }],
                contentContainerStyle: S.content,
            },
            h(Text, { style: [S.title,    { color: c("HEADER_PRIMARY", "#fff") }] }, "Thread File Deleter"),
            h(Text, { style: [S.subtitle, { color: c("TEXT_MUTED", "#949ba4") }] },
                "Deletes messages with Google Drive links or file attachments posted in threads named after blacklisted users."
            ),

            h(Text, { style: [S.label, { color: c("TEXT_NORMAL", "#dbdee1") }] }, "Blacklisted users"),
            h(TextInput, {
                style:               inputStyle,
                value:               bl,
                onChangeText:        (v) => { setBl(v); setBlacklist(v); },
                placeholder:         "User IDs or usernames, comma-separated",
                placeholderTextColor: c("TEXT_MUTED", "#87898c"),
                multiline:           true,
            }),
            h(Text, { style: [S.hint, { color: c("TEXT_MUTED", "#949ba4") }] },
                "Username (without @) or numeric user ID. Threads whose name matches get policed."
            ),

            h(Text, { style: [S.label, { color: c("TEXT_NORMAL", "#dbdee1") }] }, "Thread channel ID"),
            h(TextInput, {
                style:               inputStyle,
                value:               ch,
                onChangeText:        (v) => { setCh(v.trim()); setThreadChannelId(v.trim()); },
                placeholder:         "Parent forum / channel ID",
                placeholderTextColor: c("TEXT_MUTED", "#87898c"),
                keyboardType:        "numeric",
            }),
            h(Text, { style: [S.hint, { color: c("TEXT_MUTED", "#949ba4") }] },
                "Only threads inside this channel will be checked. Required."
            ),

            h(View, { style: [S.row, { borderBottomColor: c("BORDER_FAINT", "#ffffff14"), marginTop: 14 }] },
                h(Text, { style: [S.rowLabel, { color: c("TEXT_NORMAL", "#dbdee1") }] }, "Test mode (log, don't delete)"),
                h(Switch, {
                    value:          dry,
                    onValueChange:  (v) => { setDry(v); setDryRun(v); },
                    trackColor:     { true: c("BRAND_500", "#5865f2"), false: c("BACKGROUND_TERTIARY", "#1e1f22") },
                })
            )
        );
    }

    // -------------------------------------------------------------------------
    // Plugin lifecycle
    // -------------------------------------------------------------------------

    let interceptFn = null;

    var index = {
        onLoad() {
            // Invalidate thread cache when channel info updates
            const onChannelUpdate = (payload) => {
                if (!payload) return null;
                const ch = payload.channel || payload.Channel;
                if (ch && ch.id) threadCache.delete(ch.id);
                return null;
            };

            interceptFn = (payload) => {
                try {
                    if (!payload) return null;

                    // Bust cache on channel events
                    if (payload.type === "CHANNEL_UPDATE" || payload.type === "CHANNEL_CREATE") {
                        onChannelUpdate(payload);
                        return null;
                    }

                    if (payload.type !== "MESSAGE_CREATE") return null;
                    if (payload.optimistic) return null;

                    const msg = payload.message;
                    if (!msg || !msg.id) return null;

                    const channelId = payload.channelId || msg.channel_id;
                    if (!channelId) return null;

                    if (!isCachedBlacklistedThread(channelId)) return null;

                    const hit = hasOffendingContent(msg);
                    if (!hit) return null;

                    deleteMessage(channelId, msg.id, hit.reason);
                } catch (e) {
                    console.log("[ThreadFileDeleter] handler error: " + String(e));
                }
                return null;
            };

            FD._interceptors.push(interceptFn);
            console.log("[ThreadFileDeleter] Loaded.");
        },
        onUnload() {
            if (interceptFn) {
                FD._interceptors = FD._interceptors.filter((f) => f !== interceptFn);
                interceptFn = null;
            }
            threadCache.clear();
            console.log("[ThreadFileDeleter] Unloaded.");
        },
        settings: Settings,
    };

    return index;
})();
