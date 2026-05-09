import type { MessengerAdapter } from '../../messenger/types.js';

type PostMailAlertArgs = Parameters<MessengerAdapter['postMailAlert']>[0];
type SendFileArgs = Parameters<MessengerAdapter['sendFile']>[0];

/**
 * In-memory MessengerAdapter for unit tests.
 * Records every outbound call so tests can assert what was sent where.
 */
export class MockMessengerAdapter implements MessengerAdapter {
  readonly platform = 'mock';

  readonly calls: {
    postMailAlert: PostMailAlertArgs[];
    postToChannel: { channelId: string; content: string }[];
    sendFile: SendFileArgs[];
  } = {
    postMailAlert: [],
    postToChannel: [],
    sendFile: [],
  };

  private _mailAlertResult = {
    threadId: 'mock-thread-1',
    firstMessageId: 'mock-msg-1',
  };

  /** Override the result returned by postMailAlert for a specific test. */
  setMailAlertResult(result: { threadId: string; firstMessageId: string }): void {
    this._mailAlertResult = result;
  }

  reset(): void {
    this.calls.postMailAlert.length = 0;
    this.calls.postToChannel.length = 0;
    this.calls.sendFile.length = 0;
  }

  async postMailAlert(args: PostMailAlertArgs) {
    this.calls.postMailAlert.push(args);
    return { ...this._mailAlertResult };
  }

  async postToChannel(channelId: string, content: string): Promise<void> {
    this.calls.postToChannel.push({ channelId, content });
  }

  async sendFile(args: SendFileArgs): Promise<void> {
    this.calls.sendFile.push({ ...args });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
