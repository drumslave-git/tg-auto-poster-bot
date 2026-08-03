import { Bot, GrammyError, HttpError } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { notifyDashboard } from '../events.js';
import { clearAlbumBuffers } from './albumBuffer.js';
import { forgetCommandMenus, syncCommandMenu } from './commands.js';
import { registerHandlers } from './handlers.js';

export type BotStatus = 'stopped' | 'starting' | 'running' | 'error';

export type BotState = {
  status: BotStatus;
  error: string | null;
  info: UserFromGetMe | null;
};

const ALLOWED_UPDATES = ['message', 'channel_post', 'my_chat_member'] as const;

class BotManager {
  private bot: Bot | null = null;
  private token: string | null = null;
  private status: BotStatus = 'stopped';
  private error: string | null = null;
  private info: UserFromGetMe | null = null;
  /** Serializes start/stop so rapid token edits cannot interleave. */
  private transition: Promise<void> = Promise.resolve();

  getState(): BotState {
    return { status: this.status, error: this.error, info: this.info };
  }

  /** The Api handle, or null while the bot is not running. */
  getApi() {
    return this.status === 'running' && this.bot ? this.bot.api : null;
  }

  /** Idempotent: a no-op when the token is already the running one. */
  async apply(token: string | null): Promise<BotState> {
    const next = token?.trim() || null;
    this.transition = this.transition.then(async () => {
      if (next === this.token && (this.status === 'running' || this.status === 'starting')) return;
      await this.stopInternal();
      this.token = next;
      if (next) await this.startInternal(next);
    });
    await this.transition;
    return this.getState();
  }

  async restart(): Promise<BotState> {
    const token = this.token;
    this.transition = this.transition.then(async () => {
      await this.stopInternal();
      if (token) await this.startInternal(token);
    });
    await this.transition;
    return this.getState();
  }

  async shutdown(): Promise<void> {
    this.transition = this.transition.then(() => this.stopInternal());
    await this.transition;
  }

  private async startInternal(token: string): Promise<void> {
    this.status = 'starting';
    this.error = null;
    notifyDashboard();

    const bot = new Bot(token);
    registerHandlers(bot);

    try {
      await bot.init();
    } catch (error) {
      this.status = 'error';
      this.error = describeError(error);
      console.error('[bot] failed to start:', this.error);
      notifyDashboard();
      return;
    }

    this.bot = bot;
    this.info = bot.botInfo;
    this.status = 'running';
    console.log(`[bot] running as @${bot.botInfo.username}`);
    notifyDashboard();

    // The menu is Telegram-side state, not ours; publishing it must not hold up
    // polling, and a failure only costs the ☰ button its contents.
    void syncCommandMenu(bot.api).catch((error) =>
      console.warn('[bot] command menu not published:', describeError(error)),
    );

    // start() resolves only once the bot stops; deliberately not awaited.
    void bot.start({ allowed_updates: [...ALLOWED_UPDATES] }).catch((error) => {
      this.status = 'error';
      this.error = describeError(error);
      console.error('[bot] polling stopped:', this.error);
      notifyDashboard();
    });
  }

  private async stopInternal(): Promise<void> {
    clearAlbumBuffers();
    forgetCommandMenus();
    const bot = this.bot;
    this.bot = null;
    this.info = null;
    this.status = 'stopped';
    this.error = null;
    notifyDashboard();
    if (!bot) return;
    try {
      await bot.stop();
    } catch (error) {
      console.error('[bot] error while stopping:', describeError(error));
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof GrammyError) return `Telegram API: ${error.description}`;
  if (error instanceof HttpError) return `Network: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export const botManager = new BotManager();
