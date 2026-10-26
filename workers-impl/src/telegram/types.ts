/** Telegram Bot API 相关类型（只取用得到的字段）。 */

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string; // private | group | supergroup | channel
  first_name?: string;
  username?: string;
}

/** 语音消息（voice = 普通语音；audio = 当音频文件发的，兼容处理）。 */
export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  voice?: TgVoice;
  audio?: TgVoice;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TgFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

export interface TgSentMessage {
  message_id: number;
  chat: TgChat;
  text?: string;
}
