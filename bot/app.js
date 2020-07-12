const botConfig = require('../bot.config');
const settings = require('./settings');
const chatsScheduler = require('./schedulers').chats;

const HttpsProxyAgent = require('https-proxy-agent');
const { DanmakuSourceManager } = require('./api');
const BotWrapper = require('./bot-wrapper');
const Extra = require('telegraf/extra');
const Markup = require('telegraf/markup');
const log4js = require('log4js');
const path = require('path');

const MANAGE_PAGE_MAX_ITEMS = 4;
const USER_STATE_CODE_CHAT_CHANGE_DANMAKU_SRC = 1;
const USER_STATE_CODE_CHAT_CHANGE_PATTERN = 2;
const USER_STATE_CODE_CHAT_CHANGE_ADMIN = 3;
const USER_STATE_CODE_CHAT_CHANGE_BLOCK_USERS = 4;
const USER_STATE_CODE_CHAT_MANAGE_SCHEDULES = 5;

class DanmaquaBot extends BotWrapper {
    constructor({ dmSrc, botToken, agent, logger }) {
        super({ botConfig, botToken, agent, logger });
        this.startCommandSimpleMessage = '欢迎使用 Danmaqua Bot！';
        this.dmSrc = dmSrc;

        this.addCommands([
            {
                command: 'list_dm_src',
                title: '查询支持的弹幕源',
                description: '查看 Bot 支持哪些直播平台的弹幕源',
                help: '使用方法： /list\\_dm\\_src',
                botAdminOnly: false,
                callback: this.onCommandListDMSrc
            },
            {
                command: 'register_chat',
                title: '注册频道',
                description: '让 Bot 将指定直播间的弹幕转发到频道中',
                help: '使用方法：/register\\_chat \\[频道ID] \\[直播间号] \\[弹幕源(可选)]',
                botAdminOnly: true,
                callback: this.onCommandRegisterChat
            },
            {
                command: 'unregister_chat',
                title: '取消注册频道',
                description: '对频道取消绑定弹幕转发',
                help: '使用方法：/unregister\\_chat \\[频道ID]',
                botAdminOnly: true,
                callback: this.onCommandUnregisterChat
            },
            {
                command: 'manage_chats',
                title: '管理频道',
                description: '列出已经绑定了弹幕转发的频道，并进行选择管理',
                help: '使用方法：/manage\\_chats',
                botAdminOnly: false,
                callback: this.onCommandManageChats
            },
            {
                command: 'manage_chat',
                title: '管理指定的频道',
                description: '管理指定的已绑定弹幕转发的频道',
                help: '使用方法：/manage\\_chat \\[频道ID]',
                botAdminOnly: false,
                callback: this.onCommandManageChat
            },
            {
                command: 'set_default_admins',
                title: '设置默认管理员',
                description: '设置各个频道的默认管理员（并非 Bot 管理员）',
                help: '使用方法：/set\\_default\\_admins \\[第一个管理员ID] \\[第二个管理员ID] ...',
                botAdminOnly: true,
                callback: this.onCommandSetDefaultAdmins
            },
            {
                command: 'set_default_pattern',
                title: '设置默认过滤规则',
                description: '设置各个频道的默认过滤规则',
                help: '使用方法：/set\\_default\\_pattern \\[正则表达式]',
                botAdminOnly: true,
                callback: this.onCommandSetDefaultPattern
            },
            {
                command: 'set_default_source',
                title: '设置默认过滤规则',
                description: '设置各个频道的默认过滤规则',
                help: '使用方法：/set\\_default\\_source \\[正则表达式]',
                botAdminOnly: true,
                callback: this.onCommandSetDefaultSource
            }
        ]);
        this.addActions([
            [/^manage_chat:([-\d]+)/, this.onActionManageChat],
            [/^manage_chats_pages:(\d+)/, this.onActionManageChatsPages],
            [/^change_danmaku_src:([-\d]+)/, this.onActionChangeDanmakuSrc],
            [/^change_pattern:([-\d]+)/, this.onActionChangePattern],
            [/^change_admin:([-\d]+)/, this.onActionChangeAdmin],
            [/^change_blocked_users:([-\d]+)/, this.onActionChangeBlockedUsers],
            [/^unregister_chat:([-\d]+)/, this.onActionUnregisterChat],
            [/^confirm_unregister_chat:([-\d]+)/, this.onActionConfirmUnregisterChat],
            [/^reconnect_room:([a-zA-Z\d]+)_([-\d]+)/, this.onActionReconnectRoom],
            [/^block_user:([-\d]+):([-_a-zA-Z\d]+)/, this.onActionBlockUser],
            [/^manage_schedules:([-\d]+)/, this.onActionManageSchedules],
        ]);

        this.bot.command('cancel', this.onCommandCancel);
        this.bot.on('message', this.onMessage);
    }

    notifyDanmaku = async (chatId, data, { hideUsername = false }) => {
        let msg = '';
        if (!hideUsername) {
            const url = data.sender.url + '#' + data.sourceId + '_' + data.sender.uid;
            msg += `<a href="${url}">${data.sender.username}</a>：`;
        }
        msg += data.text;
        const extras = Extra.HTML().webPreview(false).notifications(false);
        return await this.bot.telegram.sendMessage(chatId, msg, extras);
    };

    getManagedChatsConfig = (userId) => {
        const result = [];
        const chatConfigs = settings.getChatConfigs();
        for (let chatId of Object.keys(chatConfigs)) {
            const chatConfig = Object.assign({}, chatConfigs[chatId], { chatId });
            if (this.hasUserPermissionForBot(userId) || chatConfig.admin.indexOf(userId) !== -1) {
                result.push(chatConfig);
            }
        }
        return result;
    };

    getManagedChatsCount = (userId) => {
        let count = 0;
        const chatConfigs = settings.getChatConfigs();
        for (let chatId of Object.keys(chatConfigs)) {
            const chatConfig = Object.assign({}, chatConfigs[chatId], { chatId });
            if (this.hasUserPermissionForBot(userId) || chatConfig.admin.indexOf(userId) !== -1) {
                count++;
            }
        }
        return count;
    }

    getManagedChatsPageCount = (userId) => {
        return Math.ceil(this.getManagedChatsCount(userId) / MANAGE_PAGE_MAX_ITEMS);
    }

    getManagedChatsConfigByPage = (userId, page) => {
        const chatConfigs = this.getManagedChatsConfig(userId);
        const minIndex = page * MANAGE_PAGE_MAX_ITEMS;
        const maxIndex = minIndex + MANAGE_PAGE_MAX_ITEMS;
        return chatConfigs.filter((v, index) => index >= minIndex && index < maxIndex);
    };

    onMessage = async (ctx) => {
        if (ctx.message.forward_from_chat) {
            if (await this.onForwardMessageFromChat(ctx)) {
                return;
            }
        }
        const userId = ctx.message.from.id;
        const stateCode = settings.getUserStateCode(userId);
        const stateData = settings.getUserStateData(userId);
        if (stateCode === USER_STATE_CODE_CHAT_CHANGE_DANMAKU_SRC) {
            this.onAnswerChangeDanmakuSrc(ctx, stateData);
        } else if (stateCode === USER_STATE_CODE_CHAT_CHANGE_PATTERN) {
            this.onAnswerChangePattern(ctx, stateData);
        } else if (stateCode === USER_STATE_CODE_CHAT_CHANGE_ADMIN) {
            this.onAnswerChangeAdmin(ctx, stateData);
        } else if (stateCode === USER_STATE_CODE_CHAT_CHANGE_BLOCK_USERS) {
            this.onAnswerChangeBlockedUsers(ctx, stateData);
        } else if (stateCode === USER_STATE_CODE_CHAT_MANAGE_SCHEDULES) {
            this.onAnswerManageSchedules(ctx, stateData);
        }
    };

    onForwardMessageFromChat = async (ctx) => {
        const chatId = ctx.message.forward_from_chat.id;
        if (!ctx.message.text || ctx.message.chat.type !== 'private') {
            return;
        }
        if (!this.hasPermissionForChat(ctx.message.from.id, chatId)) {
            ctx.reply('你没有这个对话的管理权限。');
            return;
        }
        if (!settings.getChatConfig(chatId)) {
            ctx.reply('这个对话没有在 Bot 注册。');
            return;
        }
        // 提取弹幕中的用户信息，如果没有则提示错误
        let username = null;
        let uid = 0;
        if (ctx.message.entities.length === 1) {
            const firstEntity = ctx.message.entities[0];
            if (firstEntity.type === 'text_link') {
                const [_, result] = firstEntity.url.split('#');
                if (result && result.indexOf('_') >= 0) {
                    uid = result;
                    username = ctx.message.text.substr(firstEntity.offset, firstEntity.length);
                }
            }
        }
        if (!username) {
            ctx.reply('这条消息无法寻找到弹幕用户信息。');
            return;
        }
        ctx.reply('你要对这条弹幕进行什么操作：', Extra.inReplyTo(ctx.message.message_id)
            .markup(Markup.inlineKeyboard([
                Markup.callbackButton(
                    `屏蔽用户：${username}（${uid}）`,
                    `block_user:${chatId}:${uid}`
                )
            ])));
    };

    onActionBlockUser = async (ctx) => {
        const actionUser = ctx.update.callback_query.from;
        const chatId = ctx.match[1];
        const uid = ctx.match[2];
        if (!this.hasPermissionForChat(actionUser.id, chatId)) {
            return await ctx.answerCbQuery('你没有权限设置这个对话。', true);
        }
        if (!settings.getChatConfig(chatId)) {
            return await ctx.answerCbQuery('这个对话没有在 Bot 中注册。', true);
        }
        const isBlocked = settings.containsChatBlockedUser(chatId, uid);
        if (isBlocked) {
            settings.removeChatBlockedUsers(chatId, uid);
        } else {
            settings.addChatBlockedUsers(chatId, uid);
        }
        return await ctx.answerCbQuery(
            '用户 ' + uid + ' 已在对话 ' + chatId + ' 中被' + (isBlocked ? '解除屏蔽' : '屏蔽'),
            true
        );
    };

    onCommandRegisterChat = async (ctx) => {
        let [_, chatId, roomId, source] = ctx.message.text.split(' ');
        if (!chatId) {
            ctx.reply('注册命令使用方法：/register_chat `chatId` `roomId` `\\[source]`', Extra.markdown());
            return;
        }
        if (!roomId) {
            ctx.reply('请输入房间号！');
            return;
        }
        if (isNaN(Number(roomId))) {
            ctx.reply('房间号必须是数字。');
            return;
        }
        if (source && !settings.danmakuSources.find((value) => value.id === source)) {
            ctx.reply(`弹幕源 ${source} 不受支持。`);
            return;
        }
        const targetChat = await this.getChat(chatId);
        const canSend = targetChat != null && await this.canSendMessageToChat(targetChat.id);
        if (!canSend) {
            ctx.reply('Bot 不被允许发送消息到对话 id=' + targetChat.id);
            return;
        }
        chatId = targetChat.id;
        roomId = Number(roomId);
        const curRoomId = settings.getChatConfig(chatId).roomId;
        let curDanmakuSource = settings.getChatConfig(chatId).danmakuSource;
        if (curRoomId !== roomId || curDanmakuSource !== source) {
            if (curRoomId) {
                this.dmSrc.leaveRoom(curDanmakuSource, curRoomId);
            }
            settings.setChatRoomId(chatId, roomId);
            settings.setChatDanmakuSource(chatId, source);
            curDanmakuSource = settings.getChatConfig(chatId).danmakuSource;
            this.dmSrc.joinRoom(curDanmakuSource, roomId);
        }
        ctx.reply(
            `对话 id=${targetChat.id} 已被注册到弹幕源 ` +
            `${curDanmakuSource}:${roomId}`
        );
        this.user_access_log(ctx.message.from.id, 'Registered chat id=' + chatId +
            ' to room: ' + curDanmakuSource + ' ' + roomId);
    };

    onCommandUnregisterChat = async (ctx) => {
        let [_, chatId] = ctx.message.text.split(' ');
        if (!chatId) {
            ctx.reply('取消注册命令使用方法：/unregister_chat `chatId`', Extra.markdown());
            return;
        }
        const targetChat = await this.getChat(chatId || ctx.chat.id);
        if (!targetChat) {
            ctx.reply('无法找到这个对话。');
            return;
        }
        chatId = targetChat.id;
        this.requestUnregisterChat(ctx, chatId);
    };

    createManageChatsMessageKeyboard = async (userId, page) => {
        const buttons = [];
        for (let cfg of this.getManagedChatsConfigByPage(userId, page)) {
            const chat = await this.getChat(cfg.chatId);
            let displayName = '' + cfg.chatId;
            if (chat) {
                if (chat.title && !chat.username) {
                    displayName = chat.title;
                } else if (!chat.title && chat.username) {
                    displayName = '@' + chat.username;
                } else if (chat.title && chat.username) {
                    displayName = chat.title + ' (@' + chat.username + ')';
                }
            }
            buttons.push([Markup.callbackButton(displayName, 'manage_chat:' + cfg.chatId)]);
        }
        const pageButtons = [];
        const pageCount = this.getManagedChatsPageCount(userId);
        pageButtons.push(Markup.callbackButton('第' + (page+1) + '/' + pageCount + '页', 'noop'));
        if (page > 0) {
            pageButtons.push(Markup.callbackButton('上一页', 'manage_chats_pages:' + (page - 1)));
        }
        if (page < pageCount - 1) {
            pageButtons.push(Markup.callbackButton('下一页', 'manage_chats_pages:' + (page + 1)))
        }
        if (pageButtons.length > 1) {
            buttons.push(pageButtons);
        }
        return Markup.inlineKeyboard(buttons);
    };

    onCommandManageChats = async (ctx) => {
        const userId = ctx.message.from.id;
        ctx.reply(
            '请选择你要管理的频道：\n如果你要找的频道没有显示，可能是你的账号没有权限。',
            Extra.markup(await this.createManageChatsMessageKeyboard(userId, 0))
        );
    };

    onActionManageChatsPages = async (ctx) => {
        const userId = ctx.update.callback_query.from.id;
        const targetPage = parseInt(ctx.match[1]);
        if (targetPage >= 0 && targetPage < this.getManagedChatsPageCount(userId)) {
            await ctx.editMessageReplyMarkup(await this.createManageChatsMessageKeyboard(userId, targetPage));
            return await ctx.answerCbQuery();
        } else {
            return await ctx.answerCbQuery('你选择的页数 ' + targetPage + ' 不存在。', true);
        }
    };

    onActionManageChat = async (ctx) => {
        const targetChatId = parseInt(ctx.match[1]);
        if (!await this.canSendMessageToChat(targetChatId)) {
            return await ctx.answerCbQuery(
                '这个机器人无法发送消息给对话：' + targetChatId + '。请检查权限配置是否正确。', true);
        }
        this.requestManageChat(ctx, targetChatId);
        return await ctx.answerCbQuery();
    };

    requestManageChat = async (ctx, chatId) => {
        const chat = await this.getChat(chatId);
        let displayName = '' + chat.id;
        if (chat.title && !chat.username) {
            displayName = chat.title;
        } else if (!chat.title && chat.username) {
            displayName = '@' + chat.username;
        } else if (chat.title && chat.username) {
            displayName = chat.title + ' (@' + chat.username + ')';
        }
        const config = settings.getChatConfig(chatId);
        const dmSrc = config.danmakuSource;
        const roomId = config.roomId;
        let msgText = `你想要修改频道 “${displayName}” (id: ${chat.id}) 的什么设置？\n`;
        msgText += `房间号/弹幕源：${roomId} ${dmSrc}\n`;
        msgText += '过滤规则：' + config.pattern;
        ctx.reply(msgText, Extra.markup(Markup.inlineKeyboard([
            [
                Markup.callbackButton('房间号/弹幕源', 'change_danmaku_src:' + chat.id),
                Markup.callbackButton('过滤规则', 'change_pattern:' + chat.id),
                Markup.callbackButton('管理员', 'change_admin:' + chat.id)
            ],
            [
                Markup.callbackButton('屏蔽用户', 'change_blocked_users:' + chat.id),
                Markup.callbackButton('重连房间', `reconnect_room:${dmSrc}_${roomId}`)
            ],
            [
                Markup.callbackButton('计划任务', 'manage_schedules:' + chat.id),
                Markup.callbackButton('取消注册', 'unregister_chat:' + chat.id)
            ]
        ])));
    };

    onActionReconnectRoom = async (ctx) => {
        const dmSrc = ctx.match[1];
        const roomId = parseInt(ctx.match[2]);
        this.dmSrc.reconnectRoom(dmSrc, roomId);
        ctx.reply(`已经对直播房间 ${dmSrc} ${roomId} 重新连接中。` +
            `（由于目前是相同直播房间的所有对话共用一个弹幕连接，可能会影响到其它频道的弹幕转发）`);
        this.user_access_log(ctx.update.callback_query.from.id, 'Reconnect room: ' + dmSrc + ' ' + roomId);
        return await ctx.answerCbQuery();
    };

    onActionUnregisterChat = async (ctx) => {
        const targetChatId = parseInt(ctx.match[1]);
        this.requestUnregisterChat(ctx, targetChatId);
        return await ctx.answerCbQuery();
    };

    onActionConfirmUnregisterChat = async (ctx) => {
        const chatId = parseInt(ctx.match[1]);
        const regRoomId = settings.getChatConfig(chatId).roomId;
        const regSource = settings.getChatConfig(chatId).danmakuSource;
        if (!regRoomId) {
            return await ctx.answerCbQuery('这个对话未注册任何弹幕源。', true);
        }
        settings.deleteChatConfig(chatId);
        this.dmSrc.leaveRoom(regSource, regRoomId);
        ctx.reply(`对话 id=${chatId} 已成功取消注册。`);
        this.user_access_log(ctx.update.callback_query.from.id, 'Unregistered chat id=' + chatId);
        return await ctx.answerCbQuery();
    };

    requestUnregisterChat = async (ctx, chatId) => {
        ctx.reply('你确定要取消注册对话 id=' + chatId + ' 吗？所有该对话的设置都会被清除且无法恢复。',
            Extra.markup(Markup.inlineKeyboard([
                Markup.callbackButton('是的，我不后悔', 'confirm_unregister_chat:' + chatId)
            ])));
    };

    onActionChangeDanmakuSrc = async (ctx) => {
        const targetChatId = parseInt(ctx.match[1]);
        settings.setUserState(ctx.update.callback_query.from.id,
            USER_STATE_CODE_CHAT_CHANGE_DANMAKU_SRC,
            targetChatId);
        ctx.reply('你正在编辑 id=' + targetChatId + ' 的弹幕房间号/弹幕源，' +
            '如果你只需要修改房间号，回复房间号即可。\n' +
            '如果你需要修改弹幕源，请按格式回复：`[房间号] [弹幕源]` 。' +
            '例如需要使用斗鱼 10 号房间弹幕，则回复：`10 douyu`\n\n' +
            '当前设置：房间号=`' + settings.getChatConfig(targetChatId).roomId +
            '`, 弹幕源=`' + settings.getChatConfig(targetChatId).danmakuSource + '`\n' +
            '回复 /cancel 退出互动式对话。', Extra.markdown());
        return await ctx.answerCbQuery();
    };

    onActionChangePattern = async (ctx) => {
        const targetChatId = parseInt(ctx.match[1]);
        settings.setUserState(ctx.update.callback_query.from.id,
            USER_STATE_CODE_CHAT_CHANGE_PATTERN,
            targetChatId);
        ctx.reply('你正在编辑 id=' + targetChatId + ' 的过滤规则，' +
            '符合过滤规则正则表达式的弹幕内容将会被转发到指定 id 的对话/频道中。\n\n' +
            '当前设置：`' + settings.getChatConfig(targetChatId).pattern + '`\n' +
            '回复 /cancel 退出互动式对话。', Extra.markdown());
        return await ctx.answerCbQuery();
    };

    onActionChangeAdmin = async (ctx) => {
        if (!this.hasUserPermissionForBot(ctx.update.callback_query.from.id)) {
            return await ctx.answerCbQuery('很抱歉，这项操作只有 Bot 管理员可以使用。', true);
        }
        const targetChatId = parseInt(ctx.match[1]);
        settings.setUserState(ctx.update.callback_query.from.id,
            USER_STATE_CODE_CHAT_CHANGE_ADMIN,
            targetChatId);
        ctx.reply('你正在编辑 id=' + targetChatId + ' 的管理员列表，' +
            '管理员可以对该频道修改\n\n' +
            '当前设置：`' + settings.getChatConfig(targetChatId).admin + '`\n' +
            '回复 /cancel 退出互动式对话。', Extra.markdown());
        return await ctx.answerCbQuery();
    };

    onActionChangeBlockedUsers = async (ctx) => {
        const targetChatId = parseInt(ctx.match[1]);
        const message = await ctx.reply(this.getChangeBlockedUsersMessageText(targetChatId), Extra.markdown());

        settings.setUserState(ctx.update.callback_query.from.id,
            USER_STATE_CODE_CHAT_CHANGE_BLOCK_USERS,
            {
                targetChatId,
                chatId: message.chat.id,
                messageId: message.message_id
            });
    };

    onActionManageSchedules = async (ctx) => {
        const targetChatId = parseInt(ctx.match[1]);
        const message = await ctx.reply(this.getManageSchedulesMessageText(targetChatId), Extra.markdown());

        settings.setUserState(ctx.update.callback_query.from.id,
            USER_STATE_CODE_CHAT_MANAGE_SCHEDULES,
            {
                targetChatId,
                chatId: message.chat.id,
                messageId: message.message_id
            })
    };

    getChangeBlockedUsersMessageText = (chatId) => {
        let blockedUsers = settings.getChatBlockedUsers(chatId)
            .map(({src, uid}) => src + '_' + uid);
        if (blockedUsers.length > 0) {
            blockedUsers = blockedUsers.reduce((t, next) => t + ', ' + next);
        } else {
            blockedUsers = '空';
        }
        return '你正在编辑 id=' + chatId + ' 的屏蔽用户列表，' +
            '被屏蔽的用户弹幕不会被转发到对话中。\n' +
            '输入 `add [弹幕源] [用户id]` 可以添加屏蔽用户，输入 `del [弹幕源] [用户id]` 可以解除屏蔽用户。' +
            '例如：输入 `add bilibili 100` 可以屏蔽 bilibili 弹幕源 id 为 100 的用户。\n\n' +
            '当前已被屏蔽的用户：\n`' + blockedUsers + '`\n' +
            '回复 /cancel 完成屏蔽修改并退出互动式对话。';
    };

    getManageSchedulesMessageText = (chatId) => {
        let schedules = settings.getChatSchedules(chatId)
            .map(({expression, action}) => '`' + expression + ' ' + action + '`');
        if (schedules.length > 0) {
            schedules = schedules.reduce((t, next) => t + '\n' + next);
        } else {
            schedules = '空';
        }
        return '你正在编辑 id=' + chatId + ' 的计划任务列表，' +
            '计划任务的时间格式使用 crontab 格式，同一个 crontab 表达式只能设置一个任务，' +
            '你可以相隔一秒设置不同的任务。任务命令可以参考：https://danmaqua.github.io/bot/scheduler\\_usage.html\n' +
            '输入 `add [crontab 时间] [任务命令]` 可以添加计划任务\n' +
            '输入 `del [crontab 时间]` 可以删除对应时间的任务。\n' +
            '输入 `clear` 可以清除所有计划任务且不可恢复。\n' +
            '当前已安排的任务计划：\n' + schedules + '\n' +
            '回复 /cancel 完成修改并退出互动式对话。';
    };

    onAnswerChangeDanmakuSrc = async (ctx, chatId) => {
        let [roomId, srcId] = ctx.message.text.split(' ');
        if (isNaN(roomId)) {
            ctx.reply('你输入的房间号不是合法的数字。', Extra.inReplyTo(ctx.message.message_id));
            return;
        }
        roomId = Number(roomId);
        if (srcId) {
            const src = settings.getDanmakuSource(srcId);
            if (!src) {
                ctx.reply('你输入的弹幕源不是合法的弹幕源，你可以输入 /list_dm_src 进行查询。',
                    Extra.inReplyTo(ctx.message.message_id));
                return;
            }
        }
        const curRoomId = settings.getChatConfig(chatId).roomId;
        const curDanmakuSource = settings.getChatConfig(chatId).danmakuSource;
        if (curRoomId !== roomId || curDanmakuSource !== srcId) {
            if (curRoomId) {
                this.dmSrc.leaveRoom(curDanmakuSource, curRoomId);
            }
            settings.setChatRoomId(chatId, roomId);
            settings.setChatDanmakuSource(chatId, srcId);
            this.dmSrc.joinRoom(settings.getChatConfig(chatId).danmakuSource, roomId);
        }
        const newDanmakuSource = settings.getChatConfig(chatId).danmakuSource;
        ctx.reply(`已成功为 id=${chatId} 频道注册了 ${newDanmakuSource}:${roomId} 房间弹幕转发。`);
        this.user_access_log(ctx.message.from.id, `Set chat id=${chatId} danmaku source to` +
            ` ${newDanmakuSource}:${roomId}`)
        settings.clearUserState(ctx.message.from.id);
    };

    onAnswerChangePattern = async (ctx, chatId) => {
        let pattern = ctx.message.text;
        if (!pattern) {
            ctx.reply('请输入过滤规则正则表达式。', Extra.markdown());
            return;
        }
        try {
            new RegExp(pattern);
            settings.setChatPattern(chatId, pattern);
            ctx.reply(`已成功为 id=${chatId} 频道设置了过滤规则：\`${pattern}\``, Extra.markdown());
            this.user_access_log(ctx.message.from.id, `Set chat id=${chatId} pattern to ${pattern}`);
            settings.clearUserState(ctx.message.from.id);
        } catch (e) {
            ctx.reply('设置失败，你输入的不是合法的正则表达式，错误：' + e);
        }
    };

    onAnswerChangeAdmin = async (ctx, chatId) => {
        const admins = ctx.message.text.split(' ')
            .map((value) => Number(value))
            .filter((value) => Number.isNaN(value));
        settings.setChatAdmin(chatId, admins);
        ctx.reply(`已成功为 id=${chatId} 频道设置了管理员：\`${admins}\``, Extra.markdown());
        this.user_access_log(ctx.message.from.id, `Set chat id=${chatId} admin to ${admins}`);
        settings.clearUserState(ctx.message.from.id);
    };

    onAnswerChangeBlockedUsers = async (ctx, { targetChatId, chatId, messageId }) => {
        const [operation, src, uid] = ctx.message.text.split(' ');
        if (operation !== 'add' && operation !== 'del') {
            ctx.reply('不支持的屏蔽用户操作，如果你要进行其他操作请回复 /cancel');
            return;
        }
        if (!src || !uid) {
            ctx.reply('格式错误，请认真阅读修改说明。');
            return;
        }
        if (operation === 'add') {
            settings.addChatBlockedUsers(targetChatId, src + '_' + uid);
            ctx.reply('已成功添加屏蔽用户：' + src + '_' + uid);
            this.user_access_log(ctx.message.from.id, 'Blocked danmaku user: ' + src + '_' + uid);
        } else if (operation === 'del') {
            settings.removeChatBlockedUsers(targetChatId, src + '_' + uid);
            ctx.reply('已成功取消屏蔽用户：' + src + '_' + uid);
            this.user_access_log(ctx.message.from.id, 'Unblocked danmaku user: ' + src + '_' + uid);
        }
        await this.bot.telegram.editMessageText(
            chatId, messageId, undefined,
            this.getChangeBlockedUsersMessageText(targetChatId),
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            });
    };

    onAnswerManageSchedules = async (ctx, { targetChatId, chatId, messageId }) => {
        const [operation, ...args] = ctx.message.text.split(' ');
        if (operation !== 'add' && operation !== 'del' && operation !== 'clear') {
            ctx.reply('不支持的计划任务管理操作，如果你要进行其他操作请回复 /cancel');
            return;
        }
        const cronArgs = args.slice(0, 6);
        const expression = cronArgs.length === 0 ? '' : cronArgs.reduce((a, b) => `${a} ${b}`);
        if (operation === 'add') {
            if (cronArgs.length !== 6 || !chatsScheduler.validateExpression(expression)) {
                ctx.reply('这不是正确的 crontab 格式。', Extra.inReplyTo(ctx.message.message_id));
                return;
            }
            const actions = args.slice(6);
            if (actions.length <= 0) {
                ctx.reply('请输入计划任务要执行的操作。', Extra.inReplyTo(ctx.message.message_id));
                return;
            }
            const action = actions.reduce((a, b) => `${a} ${b}`);
            if (!chatsScheduler.validateAction(action)) {
                ctx.reply('这不是正确的操作，请检查语法是否正确。', Extra.inReplyTo(ctx.message.message_id));
                return;
            }
            if (!settings.addChatSchedule(targetChatId, expression, action)) {
                ctx.reply('添加计划任务失败，请检查是否有相同的 crontab 时间。',
                    Extra.inReplyTo(ctx.message.message_id));
                return;
            }
            chatsScheduler.addScheduler(targetChatId, expression, action);
            ctx.reply('添加计划任务 `' + expression + '` 成功。',
                Extra.markdown().inReplyTo(ctx.message.message_id));
            this.user_access_log(ctx.message.from.id,
                `Add schedule: chatId=${chatId} expression=${expression} action=${action}`);
        } else if (operation === 'del') {
            if (cronArgs.length !== 6 || !chatsScheduler.validateExpression(expression)) {
                ctx.reply('这不是正确的 crontab 格式。', Extra.inReplyTo(ctx.message.message_id));
                return;
            }
            if (!settings.removeChatSchedule(targetChatId, expression)) {
                ctx.reply('移除计划任务失败，请检查是否已添加这个 crontab 时间',
                    Extra.inReplyTo(ctx.message.message_id));
                return;
            }
            chatsScheduler.removeScheduler(targetChatId, expression);
            ctx.reply('移除计划任务 `' + expression + '` 成功。',
                Extra.markdown().inReplyTo(ctx.message.message_id));
            this.user_access_log(ctx.message.from.id,
                `Remove schedule: chatId=${chatId} expression=${expression}`);
        } else if (operation === 'clear') {
            chatsScheduler.clearSchedulersForChat(targetChatId);
            settings.setChatSchedules(targetChatId, []);
            ctx.reply('已清除所有计划任务。', Extra.inReplyTo(ctx.message.message_id));
            this.user_access_log(ctx.message.from.id,
                `Clear schedules: chatId=${chatId}`);
        }
        await this.bot.telegram.editMessageText(
            chatId, messageId, undefined,
            this.getManageSchedulesMessageText(targetChatId),
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            });
    };

    onCommandManageChat = async (ctx) => {
        let [_, chatId] = ctx.message.text.split(' ');
        if (!chatId) {
            ctx.reply('管理频道命令使用方法：/manage_chat `chatId`', Extra.markdown());
            return;
        }
        const targetChat = await this.getChat(chatId || ctx.chat.id);
        if (!targetChat) {
            ctx.reply('无法找到这个对话。');
            return;
        }
        chatId = targetChat.id;
        if (!settings.getChatConfig(chatId)) {
            ctx.reply('这个对话未注册任何弹幕源。');
            return;
        }
        if (!this.hasPermissionForChat(ctx.message.from.id, chatId)) {
            ctx.reply('你没有管理这个对话的权限。');
            return;
        }
        await this.requestManageChat(ctx, chatId);
    };

    onCommandListDMSrc = async (ctx) => {
        let msgText = 'Bot 支持的弹幕源：\n';
        for (let src of settings.danmakuSources) {
            msgText += '- `' + src.id + '` : ' + src.description + '\n';
        }
        ctx.reply(msgText, Extra.markdown());
    };

    onCommandCancel = async (ctx) => {
        const code = settings.getUserStateCode(ctx.message.from.id);
        if (code < 0) {
            ctx.reply('你没有取消任何操作。');
            return;
        }
        settings.clearUserState(ctx.message.from.id);
        ctx.reply('已取消互动式操作。');
    };

    onCommandSetDefaultPattern = async (ctx) => {
        let [_, pattern] = ctx.message.text.split(' ');
        if (!pattern) {
            ctx.reply('请输入要设置的默认过滤规则。', Extra.markdown());
            return;
        }
        try {
            new RegExp(pattern);
            settings.setGlobalPattern(pattern);
            ctx.reply('成功设置默认过滤规则为：`' + pattern + '`', Extra.markdown());
            this.user_access_log(ctx.message.from.id, 'Set default pattern to ' + pattern);
        } catch (e) {
            ctx.reply('设置默认过滤规则失败，错误原因：' + e);
        }
    };

    onCommandSetDefaultAdmins = async (ctx) => {
        const admins = ctx.message.text.split(' ')
            .slice(1)
            .map((value) => Number(value))
            .filter((value) => Number.isNaN(value));
        settings.setGlobalAdmin(admins);
        ctx.reply('已设置默认管理员为 `' + admins.toString() + '`', Extra.markdown());
        this.user_access_log(ctx.message.from.id, 'Set default admin to ' + admins.toString());
    }

    onCommandSetDefaultSource = async (ctx) => {
        let [_, newSrc] = ctx.message.text.split(' ');
        if (!newSrc) {
            ctx.reply('请输入一个弹幕源 id，要查询 Bot 支持哪些弹幕源可以输入 /list_dm_src');
            return;
        }
        if (settings.danmakuSources.find((value) => value.id === newSrc)) {
            settings.setGlobalDanmakuSource(newSrc);
            ctx.reply('成功设置默认弹幕源为 ' + newSrc);
            this.user_access_log(ctx.message.from.id, 'Set default danmaku source to ' + newSrc);
        } else {
            ctx.reply('无法找到弹幕源 id=' + newSrc);
        }
    }
}

class Application {
    constructor(botConfig) {
        log4js.configure({
            appenders: {
                stdout: {
                    type: 'stdout'
                },
                outfile: {
                    type: 'dateFile',
                    filename: path.join(botConfig.logsDir, 'access-log'),
                    pattern: 'yyyy-MM-dd.log',
                    alwaysIncludePattern: true,
                    keepFileExt: false
                }
            },
            categories: {
                default: {
                    appenders: ['stdout', 'outfile'],
                    level: 'debug'
                },
                access: {
                    appenders: ['outfile'],
                    level: 'debug'
                }
            }
        });
        this.logger = {
            default: log4js.getLogger('default'),
            access: log4js.getLogger('access')
        };
        settings.init(botConfig, true);
        this.dmSrc = new DanmakuSourceManager(this.logger);
        this.agent = null;
        if (botConfig.botProxy) {
            this.agent = new HttpsProxyAgent(botConfig.botProxy);
            this.logger.default.info('Launcher: Bot is using proxy ', botConfig.botProxy);
        }
        this.bot = new DanmaquaBot({
            dmSrc: this.dmSrc,
            botToken: botConfig.botToken,
            agent: this.agent,
            logger: this.logger,
        });
        chatsScheduler.init({
            bot: this.bot,
            settings: settings,
            logger: this.logger,
        });
        this.dmSrc.on('danmaku', (danmaku) => {
            try {
                this.onReceiveDanmaku(danmaku);
            } catch (e) {
                this.logger.default.error(e);
            }
        });
        this.dmSrc.on('connect', (source) => {
            try {
                this.onConnectDMSource(source);
            } catch (e) {
                this.logger.default.error(e);
            }
        });
    }

    onReceiveDanmaku(danmaku) {
        if (!this.bot.botUser) {
            return;
        }
        for (let chatId of Object.keys(settings.chatsConfig)) {
            let chatConfig = settings.chatsConfig[chatId];
            if (chatConfig.roomId) {
                chatConfig = settings.getChatConfig(chatId);
                if (chatConfig.blockedUsers &&
                    chatConfig.blockedUsers.indexOf(danmaku.sourceId + '_' + danmaku.sender.uid) >= 0) {
                    return;
                }
                if (danmaku.sourceId === chatConfig.danmakuSource && danmaku.roomId === chatConfig.roomId) {
                    const reg = new RegExp(chatConfig.pattern);
                    if (reg.test(danmaku.text)) {
                        const opts = { hideUsername: chatConfig.hideUsername };
                        this.bot.notifyDanmaku(chatId, danmaku, opts).catch((e) => {
                            this.logger.access.error(`Failed to notify ${chatId}: `, e);
                        });
                    }
                }
            }
        }
    }

    onConnectDMSource(source) {
        for (let chatId of Object.keys(settings.chatsConfig)) {
            let chatConfig = settings.chatsConfig[chatId];
            if (chatConfig.roomId) {
                chatConfig = settings.getChatConfig(chatId);
                if (source.id === chatConfig.danmakuSource) {
                    this.dmSrc.joinRoom(chatConfig.danmakuSource, chatConfig.roomId);
                }
            }
        }
    }

    startBot() {
        this.bot.start().then(() => {
            this.logger.default.info('Launcher: Bot is launched. Username: @' + this.bot.botUser.username);
        }).catch((err) => {
            this.logger.default.error(err);
        });
    }
}

if (!botConfig.botToken || botConfig.botToken.length === 0) {
    if (process.env.DMQ_BOT_TOKEN) {
        botConfig.botToken = process.env.DMQ_BOT_TOKEN;
    }
}
if (!botConfig.botProxy) {
    if (process.env.DMQ_BOT_PROXY) {
        botConfig.botProxy = process.env.DMQ_BOT_PROXY;
    }
}
if (!botConfig.botAdmins || botConfig.botAdmins.length === 0) {
    if (process.env.DMQ_BOT_ADMINS) {
        botConfig.botAdmins = process.env.DMQ_BOT_ADMINS.split(',').map(Number);
    }
}
new Application(botConfig).startBot();
