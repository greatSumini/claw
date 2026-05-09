import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipByDomainPattern } from '../orchestrator/importance.js';

describe('shouldSkipByDomainPattern', () => {
  // Google 자동 알림 도메인
  test('no-reply@accounts.google.com → skip', () => {
    assert.equal(shouldSkipByDomainPattern('no-reply@accounts.google.com'), true);
  });
  test('noreply@accounts.google.com → skip', () => {
    assert.equal(shouldSkipByDomainPattern('noreply@accounts.google.com'), true);
  });
  test('cloudplatform-noreply@google.com → skip', () => {
    assert.equal(shouldSkipByDomainPattern('cloudplatform-noreply@google.com'), true);
  });

  // Vooster / 서비스 자동 알림
  test('no-reply@vooster.ai → skip', () => {
    assert.equal(shouldSkipByDomainPattern('no-reply@vooster.ai'), true);
  });

  // 위시켓
  test('admin@wishket.com → skip', () => {
    assert.equal(shouldSkipByDomainPattern('admin@wishket.com'), true);
  });

  // AWS 자동 알림
  test('no-reply@amazonaws.com → skip', () => {
    assert.equal(shouldSkipByDomainPattern('no-reply@amazonaws.com'), true);
  });

  // GitHub 알림 (PR, CI 등 — 마케팅이 아닌 개인화된 정보일 수 있으므로 skip 안 함)
  test('noreply@github.com → NOT skip', () => {
    assert.equal(shouldSkipByDomainPattern('noreply@github.com'), false);
  });

  // 실제 비즈니스 메일
  test('ceo@devmento.co.kr → NOT skip', () => {
    assert.equal(shouldSkipByDomainPattern('ceo@devmento.co.kr'), false);
  });
  test('yoonho.cho@daou.co.kr → NOT skip', () => {
    assert.equal(shouldSkipByDomainPattern('yoonho.cho@daou.co.kr'), false);
  });

  // Cal.com 예약 확인 메일 (중요 비즈니스 정보)
  test('hello@cal.com → NOT skip', () => {
    assert.equal(shouldSkipByDomainPattern('hello@cal.com'), false);
  });

  // 일반 no-reply 패턴 중 skip 대상
  test('no-reply@modusign.co.kr → skip', () => {
    assert.equal(shouldSkipByDomainPattern('no-reply@modusign.co.kr'), true);
  });

  // 삼성페이 등 서비스 알림
  test('pay.noreply@wallet-email.samsung.com → skip', () => {
    assert.equal(shouldSkipByDomainPattern('pay.noreply@wallet-email.samsung.com'), true);
  });
});
