# claw — Claude Code 작업 지침

## 재시작 마커 (`__CLAW_RESTART__`) 사용 규칙

마커는 claw가 검출 후 응답 본문에서 제거하고 `launchctl kickstart`로 재시작한다.
마커가 제거되면 남은 텍스트가 Discord에 전송되므로, **마커만 단독으로 출력하면 빈 메시지가 전달된다.**

**규칙: 마커 앞에 반드시 사람이 읽을 수 있는 텍스트를 한 줄 이상 포함할 것.**

```
# 올바른 예
재시작합니다.

__CLAW_RESTART__

# 잘못된 예 (Discord에 빈 메시지 전송됨)
__CLAW_RESTART__
```
