import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MockMessengerAdapter } from './mocks/messenger-adapter.js';
import { buildIgnoreSenderButtonId, parseIgnoreSenderButtonId } from '../adapters/discord.js';

describe('MockMessengerAdapter: sendFile', () => {
  test('records sendFile call with all args', async () => {
    const mock = new MockMessengerAdapter();
    await mock.sendFile({
      channelId: 'ch-001',
      threadId: 'thread-001',
      filePath: '/tmp/test.pdf',
      caption: '사업자등록증',
    });
    assert.equal(mock.calls.sendFile.length, 1);
    const call = mock.calls.sendFile[0];
    assert.equal(call.channelId, 'ch-001');
    assert.equal(call.threadId, 'thread-001');
    assert.equal(call.filePath, '/tmp/test.pdf');
    assert.equal(call.caption, '사업자등록증');
  });

  test('records sendFile call without optional caption', async () => {
    const mock = new MockMessengerAdapter();
    await mock.sendFile({ channelId: 'ch-002', threadId: null, filePath: '/tmp/img.png' });
    assert.equal(mock.calls.sendFile.length, 1);
    assert.equal(mock.calls.sendFile[0].caption, undefined);
  });

  test('reset clears sendFile calls', async () => {
    const mock = new MockMessengerAdapter();
    await mock.sendFile({ channelId: 'ch-001', threadId: null, filePath: '/tmp/a.pdf' });
    mock.reset();
    assert.equal(mock.calls.sendFile.length, 0);
  });

  test('multiple sendFile calls are all recorded', async () => {
    const mock = new MockMessengerAdapter();
    await mock.sendFile({ channelId: 'ch-1', threadId: null, filePath: '/tmp/1.pdf' });
    await mock.sendFile({ channelId: 'ch-2', threadId: 't-2', filePath: '/tmp/2.pdf' });
    assert.equal(mock.calls.sendFile.length, 2);
    assert.equal(mock.calls.sendFile[1].channelId, 'ch-2');
  });
});

describe('ignore-sender button customId helpers', () => {
  test('buildIgnoreSenderButtonId produces expected format', () => {
    const id = buildIgnoreSenderButtonId('no-reply@accounts.google.com', 'lead@awesome.dev');
    assert.equal(id, 'ignore-sender:no-reply@accounts.google.com:lead@awesome.dev');
  });

  test('parseIgnoreSenderButtonId round-trips', () => {
    const id = buildIgnoreSenderButtonId('sender@example.com', 'myaccount@gmail.com');
    const parsed = parseIgnoreSenderButtonId(id);
    assert.deepEqual(parsed, { email: 'sender@example.com', account: 'myaccount@gmail.com' });
  });

  test('parseIgnoreSenderButtonId returns null for unrelated customId', () => {
    assert.equal(parseIgnoreSenderButtonId('some-other-button:data'), null);
  });

  test('parseIgnoreSenderButtonId returns null for incomplete data', () => {
    assert.equal(parseIgnoreSenderButtonId('ignore-sender:only-email'), null);
  });

  test('MockMessengerAdapter records senderEmail/senderAccount in postMailAlert', async () => {
    const mock = new MockMessengerAdapter();
    await mock.postMailAlert({
      channelId: 'ch-1',
      threadName: 'test',
      initialMessage: 'body',
      senderEmail: 'foo@bar.com',
      senderAccount: 'me@gmail.com',
    });
    const call = mock.calls.postMailAlert[0];
    assert.equal(call.senderEmail, 'foo@bar.com');
    assert.equal(call.senderAccount, 'me@gmail.com');
  });
});
