# v1.0.0 개발 로드맵

상태: **제품·구현 설계안**. 이 문서는 구현 시작, 실행 승인, Full Access 활성화,
계정 전역 권한 변경 또는 배포 승인이 아니다. 제안한 API 이름도 아직 사용할 수 없다.

## 1. 제품 목표

현재 `v0.1.3`과 `main` 통합을 기준으로 다음 세 가지를 갖춘 안정판을 만든다.

1. **일상 작업은 덜 묻는다.** 승인된 범위의 반복 실행·검증·위임은 자동화한다.
2. **실행 권한은 더 명확하다.** 모드 이름, 저장 상태, 모델의 판단을 권한으로 오해하지 않는다.
3. **끝났다는 말을 검증할 수 있다.** 고정 검증, 실제 실행 결과, JEV 조언, 보호된 종료를 구분한다.

사용자가 선택한 범위는 **Loop의 Reviewed / Full Access 두 모드와 기존 JEV 위임 연동**이다.
별도 Full Access 포크나 worker 엔진을 만들지 않고 기존 실행 경로에 정책을 추가한다.

### v1의 권장 지원 범위

| 포함 | 우선 제외 |
| --- | --- |
| Linux 우선, 현재 POSIX 검증 경로 | Windows 완료 검증의 동등한 프로세스 회수 구현 |
| 세션 단위 JEV dynamic-goal Full Access | 공유 프로젝트 스케줄러 소유권 선출·다중 기기 스케줄링 |
| 고정·적응형 유한 목표 예산 | 무제한 목표 예산·자동 만료 연장 |
| 기존 공개 JEV 도구와 실행 소유자 | 새 daemon·worker 런타임·OS 샌드박스 |
| 현재 native TUI·RPC·지원 public API | 비공개 `src/` import·교차 저장소 트랜잭션 |
| GitHub 패키지·업데이트/복구 검증 | 별도 결정 없는 npm 발행 |

v1은 모든 플랫폼과 자동화 형태를 한 번에 해결하는 버전이 아니다.
작은 지원 범위에서 권한·복구·배포 계약을 안정화하는 것이 우선이다.

## 2. 현재 기반과 실제 차이

### 이미 있는 기반

- 정확한 목표·기준·고정 검증·작업 경로·유한 예산을 승인하는 Loop 설정 경로.
- 같은 목표에서 통상적인 검증 실패와 unmet 재작업을 반복 설정 승인 없이 이어가는 동작.
- 최초 시작과 총 하드 한도를 유지하는 적응형 운영 할당.
- 고정 검증과 공개 `jev_decide`를 거친 보호된 완료 CAS, 취소·세대·snapshot fencing.
- 짧은 기본 대시보드, 상세 초점/스크롤, bounded review receipts와 자원 회수 회귀.
- JEV 위임 확장의 기존 `/jev access full` 및 `/jev access reviewed`.

### 새로 필요한 것

- Loop가 소유하는 명시적 세션 Full Access 계약과 활성화/폐기 수명주기.
- Full Access 승인 범위 안에서 새 목표를 받는 admission 경로.
- Loop와 위임의 부분 권한 상태를 숨기지 않는 연동.
- 기준과 검증 범위를 연결해 미충족 원인을 실제 작업으로 바꾸는 운영 흐름.
- 두 모드의 실제 통합·재시작·취소·업데이트 검증과 안정 public API 계약.

**중요:** JEV 위임 Full Access는 다른 확장을 허가하지 않는다. 현재 확인한 JEV 소스에는
세션/작업 경로에 묶인 비공개 lease와 실제 네이티브 활성화가 있으나, 이를 Loop가 가져다
쓸 수 있는 public grant API는 확인되지 않았다. 저장소 소스의 기능 존재와 설치된 실행
환경의 지원 여부도 별도로 확인해야 한다.

### 0.2 구현 전 선행 판별

- 설치된 JEV의 public judge/위임 도구와 native access 지원 버전을 확인한다.
- judge 연결·수신자·profile 변경을 어떤 지원 경계로 감지하고 차단할 수 있는지 확인한다.
  기존 도구 이름이 같다는 이유만으로 새로운 수신자에게 옛 grant를 재사용하지 않는다.
- 필요한 lifetime/세대 정보가 public 인터페이스에 없으면 최소 계약을 먼저 합의한다.
  신뢰할 수 있게 차단할 수 없는 범위는 Full로 광고하지 않고 축소하거나 출시를 보류한다.
- v1 Full 대상은 기존 JEV completion이 있는 recurring idle/dynamic 목표다.
  cron/event/hybrid, workflow, orchestration, TaskStore 권한까지 자동 확대하지 않는다.

## 3. 두 모드의 제품 계약

아래에서 Reviewed는 현재 동작을 보존하는 기본 모드의 제품 명칭이다.
Loop의 Full Access 및 입력 필드는 새 제안이다.

| 항목 | Reviewed | Loop Full Access 제안 |
| --- | --- | --- |
| 기본값 | 기존 호출과 기존 데이터의 기본값 | 명시적 활성화 없이는 사용 불가 |
| 활성화 | 목표별 정확한 네이티브 설정 승인 | 세션·경로·허용 작업·목표별 상한의 네이티브 승인 |
| 새 목표 생성 | 그 목표의 정확한 설정 확인 | 살아 있는 grant와 범위가 맞으면 반복 설정 확인 생략 |
| 고정 검증 | 승인한 명령/인자만 실행 | admission 때 고정한 명령/인자만 실행 |
| 통상 재작업 | 원래 목표 범위에서 승인 재사용 | 원래 목표·grant 범위에서 자동 진행 |
| 위임 | JEV 소유자의 현재 승인 정책 적용 | JEV 소유자의 별도 실제 Full Access가 필요 |
| 완료 | 검증 통과 + 지원된 met + 보호된 CAS | 동일; 모드가 성공 판정을 대신하지 않음 |
| 재시작 | 기존 fresh approval 규칙 | grant 복원 없음; 새 실제 활성화 필요 |
| 호스트 deny | 우회하지 않음 | 우회하지 않음 |

### 활성화에 반드시 표시할 범위

- 현재 세션, 런타임/작업 경로 바인딩과 허용 작업 종류.
- **각 목표에 허용할 유한 최대 횟수·시간.** 실제 값은 활성화에서 정한다.
  과거 실행이나 문서의 숫자를 새 기본값/승인으로 재사용하지 않는다.
- 실행이 같은 OS 사용자 권한으로 이뤄지며, 경로 바인딩이 파일시스템 샌드박스는 아니라는 위험.
- 공개 JEV 및 worker에 허용되는 데이터 종류와 전달 대상. 비밀·원문·전체 이력 수집은 불포함.
- 종료·폐기·범위 변경 시 효력이 사라지고 취소가 롤백은 아니라는 사실.
- 상위 Pi 권한, profile 제한, 고정 검증, 입력 검증과 자원 회수는 유지된다는 사실.

Full Access의 목표별 한도는 계정 전체나 JEV의 별도 세션 비용 정책과 다르다.
새 누적 토큰/금액 제한을 임의로 만들지는 않지만, 각 Loop 목표의 하드 예산은 유한해야 한다.

### Full Access가 자동으로 허용하지 않는 것

관리자 권한 상승, 계정/키 변경, 비밀 전송, 전역 설치, 새 수신자·작업 경로·제공자 범위,
미리 승인되지 않은 배포·파괴적 작업, 만료/취소 목표 복원 및 호스트 permission gate 우회.
필요하면 정확한 차이에 대한 별도 사용자 결정으로 다룬다.

## 4. 최소 사용자 흐름

### 정상 흐름

1. 사용자가 Loop Full Access 활성화 화면에서 정확한 세션 범위를 승인한다.
2. 위임을 쓸 경우 기존 JEV 소유자에서도 실제 세션 Full Access를 활성화한다.
3. 사용자는 자연어 목표를 준다. 부모는 기존처럼 비민감 영어 정책·기준·알려진 고정 검증을 준비한다.
4. Loop는 목표의 실제 hard envelope와 live grant 범위를 대조한 후 생성한다.
5. 범위 내 작업·필요한 위임·검증·unmet 수정은 반복 설정 확인 없이 진행한다.
6. 실제 검증 통과와 지원된 met만 보호된 종료로 이어진다. 결과와 근거 한계를 짧게 보고한다.

검증 명령을 모르거나 목표가 허용 범위를 벗어나면 생성 전에 구체적인 부족 항목을 알린다.
Full Access라는 이유로 검증기를 만들어낸 척하거나 성공 조건을 낮추지 않는다.

### 철회/경로 변경 흐름

1. 새 admission을 먼저 막고 실행 중인 owned 작업에 취소를 전달한다.
2. 검증 프로세스와 worker 회수는 실제 소유자가 수행한다.
3. 미완료 Full 목표는 LoopStore의 기존 pause/CAS 경로로 보존하고 다시 깨우지 않는다.
4. 회수 결과가 불명확하면 `revoking`/차단 상태를 유지한다. 정상 복귀나 remote quiescence를 추정하지 않는다.
5. 새 범위에서 재개하려면 새 실제 승인 또는 명시적 Reviewed 경로가 필요하다.

특정 목표 취소는 그 목표와 owned 작업만 취소한다. 다른 목표나 JEV 세션 모드까지
묵시적으로 끄지 않는다. 반대로 Loop 모드 해제가 JEV grant 자체를 대신 폐기해서도 안 된다.

## 5. 권한과 데이터 모델

### 저장 의도와 살아 있는 권한을 분리

| 데이터 | 소유/수명 | 권한 의미 |
| --- | --- | --- |
| 목표·기준·고정 검증·예산·상태 | 기존 LoopStore | 컨트롤러 의도와 이력; 승인 아님 |
| 요청 모드·승인 출처 라벨 | 필요 시 inert metadata | 설명/감사 목적; 실행 허가 아님 |
| 실제 Loop Full grant | 해당 런타임의 메모리 | 네이티브 활성화와 현재 바인딩으로만 유효 |
| JEV 위임 grant/worker 실행 | JEV 위임 소유자 | Loop가 복사·복원·발급하지 않음 |
| 완료 review receipt | 부모 도구 결과/세션 이력 | 관찰 자료; 승인이나 새로운 검증 증거 아님 |

계획상 live grant의 개념 필드는 소유자 ID, 세션·cwd·store identity·runtime generation,
access epoch, 지원되는 judge 연결 세대, 허용 작업, 목표별 ceiling과 취소 signal이다. 이 객체를 도구 인자나
직렬화된 결과로 받지 않는다. 설정의 `full` 값이나 peer의 상태 보고로 재구성하지 않는다.

### 상태 전이 초안

```text
Reviewed
  → AwaitingNativeAck
  → FullLive
  → Revoking / Draining
  → Reviewed

종료 → Closed
거절·stale 응답 → grant 없음
불명확한 회수 → Revoking 유지
```

- 네이티브 응답은 원래 요청 identity와 현재 바인딩에 맞아야 한다.
- `FullLive`에서만 범위 내 admission이 가능하다.
- revoke는 await 전에 새 효과를 차단한다. 회수 완료 전에 다시 활성화하지 않는다.
- switch/fork/tree/compact/shutdown/reload 및 필요한 연결·profile 변경 경계를 검증한다.
- 기존 Reviewed의 dialog/승인 수명 규칙은 자동으로 바꾸지 않는다.
- 모든 await 뒤와 검증·전송·최종 CAS 직전에 live epoch·store/context identity와 목표 snapshot을 다시 확인한다.
- Full admission을 Reviewed 승인 영수증으로 위장하지 않는다. 실제 승인 출처를 별도 provenance로 남긴다.

### API/명령 설계 방향 — 아직 미구현

- `LoopCreate`에 요청 모드를 표시할 선택 필드를 검토한다. 예시 이름은
  `requestedAccess: reviewed | full`이며 구현 전 public schema를 확정한다.
- 필드 생략은 기존 Reviewed 동작이다. `full` 인자 자체로 활성화나 권한 상승은 일어나지 않는다.
- goal-first UI는 사용자가 선택한 모드 의도를 전달하되 실제 admission에서 grant를 검사한다.
- `LoopUpdate`로 목표의 모드·정책·hard envelope를 임의 교체하지 않는다.
- 모드 전환 때문에 툴 스키마를 매 요청 바꾸지 않는다. 정적 스키마와 런타임 검사로 처리한다.
- 상태 UI에는 Loop/JEV 위임의 각 모드, 대기·철회·차단 이유를 구분해 표시한다.
- 현재 사용자에게 새 Loop 명령이 이미 존재한다고 안내하지 않는다.

## 6. 기존 JEV 위임 연동

실행 요청은 기존 공개 위임 도구와 nested-tool 경계로 들어가야 한다.
profile·모델·thinking·도구·파일 범위·원래 job 한도와 실행 동시성은 실제 소유자가 집행한다.
Loop는 TaskStore 작업이나 workflow execution을 자동 발견해 별도 worker 큐로 만들지 않는다.

| Loop 상태 | 위임 상태 | 기대 동작 |
| --- | --- | --- |
| Reviewed | Reviewed | 각 소유자의 기존 승인 흐름 |
| Full | Reviewed | 자동 위임 admission 차단; 별도 Reviewed 요청을 명시적으로 선택한 경우에만 기존 승인 흐름 |
| Reviewed | Full | 위임 grant로 Loop 목표 설정 승인을 생략하지 않음 |
| Full | Full | 양쪽 바인딩과 job 범위가 유효할 때만 반복 리뷰 축소 |
| Full | 미지원/미확인/철회 중 | 위임 admission 차단; 자동 활성화·다른 엔진 fallback 없음 |

v1 최소안은 **권한 영역마다 실제 활성화를 한 번씩** 받는 것이다.
단일 확인창이나 단일 저장 boolean으로 두 소유자의 승인을 합치지 않는다.

상태 확인용 public capability 인터페이스가 없다면 0.3에서 먼저 합의한다.
응답은 지원 버전·가능 기능·현재 모드/세대 같은 최소 정보이며 permission receipt가 아니다.
실제 실행 도구는 그 순간 자기 grant를 다시 검증해야 한다. 오래된 capability 응답은
신규 job의 권한이 될 수 없다. 인터페이스가 없으면 미확인으로 표시하고 필요한 작업만 차단한다.

비공개 grant export, deep import, 교차 저장소 트랜잭션은 금지한다.
vendored RPC를 바꾸는 경우 해당 VENDOR_REV·동기화 소비자·양쪽 회귀 규칙도 적용한다.

## 7. 검증과 완료 근거

### 기준을 만들 때 세 종류를 분리

| 종류 | 예 | 처리 |
| --- | --- | --- |
| 기계 검증 가능 | 테스트, 타입, 패키지 해시 | 알려진 고정 검증과 실제 exit/산출물로 확인 |
| 에이전트 기술 판단 | 정보 밀도, 키보드 동선, 복구 설명 | 현재 native 화면·고정 과제·bounded 관측과 한계를 기록 |
| 사람만 답할 수 있음 | 만족도, 주관적 선호, 실제 설문 | 명시적 연구 요구가 없으면 선택 항목; 없는 점수는 만들지 않음 |

자동 테스트 통과를 공개 설치나 실제 사용자 만족의 증명으로 확대하지 않는다.
반대로 선택적 설문이 없다는 이유로 에이전트가 직접 할 수 있는 검토까지 사용자에게 넘기지 않는다.

v1은 기존 비민감 영어 전송 계약과 현재 evidence/context 한도를 유지하는 것을 기본안으로 한다.
원본 목표·소스·경로·argv·stdout/stderr·이력·비밀은 자동 수집/전송하지 않는다.
새 근거 형식이 필요하면 privacy/호환성 기대를 먼저 정하고 별도 변경으로 다룬다.

- 고정 검증은 목표가 만들어질 때 고정한다. 명령·인자·cwd·설명 변경으로 같은 목표를 통과시키지 않는다.
- 검증 nonzero와 JEV unmet는 원래 범위 안의 조사·수정으로 연결한다.
- 누락·충돌·불충분한 근거는 unmet이며, 요약 재문구화·일정 변경만으로 재심사하지 않는다.
- provider 오류·잘못된 응답·취소·불명확한 종료는 성공이나 자동 재시도/fallback 권한이 아니다.
- 종료는 검증 통과 + 지원된 met + live 권한 + 기존 LoopStore CAS를 모두 만족해야 한다.
- 기록에는 실제 exit/signal/검증 범위, 기준별 조언, 문맥 길이/해시와 출처를 bounded하게 남긴다.

## 8. 마일스톤과 종료 조건

### 0.2 — Loop Full Access 최소 수직 기능

**산출물:** 모드 계약, 순수 상태 전이, 네이티브 활성화/해제, admission/effect 경계, 상태 UI.

**종료 조건**

- 같은 범위의 새 목표 두 개를 만드는 고정 사례에서, Full의 실제 활성화는 한 번이고
  목표별 반복 설정 확인은 없다. Reviewed는 기존 목표별 확인을 유지한다.
- 거절·없는 UI·잘못된 바인딩·폐기·만료·재시작에서 새 컨트롤러/프로세스/전송이 없다.
- host deny를 무시하지 않으며, 완전 자동 진행이 불가능한 이유를 사실대로 표시한다.
- 고정/적응형 하드 한도와 기존 컨트롤러의 동작이 유지된다.

**범위 제한:** worker 연동을 동시에 만들지 않는다. 먼저 Loop 한 소유자의 수명주기를 끝낸다.

### 0.3 — 기존 JEV 위임 연동

**산출물:** 지원 public capability 계약 또는 명확한 미지원 처리, 기존 도구 adapter,
부분 권한 표시, owned job identity를 이용한 취소·결과 연결.

**종료 조건**

- 위 권한 조합 행렬을 모두 검증하고, 다른 owner의 grant를 복사하거나 자동 활성화하지 않는다.
- worker profile/model/tool/file 범위를 확장하지 않고 현재 실행/동시성 소유자를 재사용한다.
- 같은 작업 경로의 동시 writer를 만들지 않는다. 병렬 쓰기가 필요하면 기존 소유자의 격리 기능을 이용한다.
- JEV 권한 철회·연결/profile 변경·늦은 결과가 Loop의 새 실행/완료를 허가하지 않는다.
- Loop 취소 시 자기 작업만 회수하며, 다른 세션/수동 위임 작업을 잘못 취소하지 않는다.

**의존성:** 0.2의 admission/epoch 계약과 실제 설치 환경의 public 지원 범위가 먼저 고정돼야 한다.

### 0.4 — 근거·복구·무인 진행 품질

**산출물:** 기준/검증 범위 대응, 세 종류 근거 표시, 재작업 진단, 오류별 다음 행동,
상태·권한·운영 예산/하드 한도의 구분.

**종료 조건**

- 고정 실패 → 실제 수정 → 같은 검증 통과 → 실제 JEV → 보호된 종료를 확인한다.
- 단순히 깨우거나 요약을 바꿔 같은 사실을 반복 심사하지 않는다.
- budget checkpoint, 관리상 pause, 권한 폐기, 만료와 provider 실패가 서로 다른 복구 경로를 가진다.
- 중단된 검증/worker는 회수 결과를 확인하기 전 다음 작업으로 넘어가지 않는다.
- 사용자에게 일반 UI 점검·자동 측정 업무를 반복해서 넘기지 않는다.

### 0.9 — 출시 후보

**산출물:** 호스트/worker SDK·플랫폼 지원 행렬, API/schema 고정안, 업데이트·복구 문서,
재현 가능한 릴리스 패키지와 실제 통합 시험 결과.

**종료 조건**

- Reviewed와 Full을 각각 실제 정상·unmet·거절·취소·재시작 경로로 검증한다.
- 현재 소스/설치 스냅샷을 구분하고, 누락된 provider나 승인·SKIP를 통과로 세지 않는다.
- 공개 패키지 다운로드, 해시, independent rebuild, 깨끗한 Pi 설치/로딩을 검증한다.
- 알려진 제한을 사용자 화면·문서·릴리스 노트에 일관되게 반영한다.

### 1.0.0 — 안정판

위 계약과 아래 품질 gate를 고정하고, 재현 가능한 운영 범위로 안정판을 선언한다.
이름만 Full Access이거나 반복 확인을 실제로 줄이지 못하는 상태는 1.0 완료가 아니다.

## 9. 권장 PR 순서와 의존성

다음은 작업 분해안이며 현재 구현된 PR 목록이 아니다.
의존 PR은 앞 PR을 대상으로 쌓고 각 중간 커밋의 관련 검사를 통과시킨다.
Red 기대는 개인 검증 로그로 보존하고 구현과 함께 green이 되는 단위로 커밋한다.
후속 기능이 없는데 positive 기대를 SKIP하거나 실패한 PR을 정상 단계로 배포하지 않는다.

| PR | 범위 | 선행 조건 | 병합 전 핵심 증거 |
| --- | --- | --- | --- |
| 1 | 권한/호환성·연결 lifetime 선행 판별, 계약과 feature expectations | 현재 baseline | 기존 Reviewed/fixed/adaptive 통제, 무권한 효과0 기대와 지원/미지원 경계 |
| 2 | volatile access 상태 전이·바인딩·revocation | PR1 | 상태 생성 속성, drift/늦은 응답/동시 revoke 최소 회귀 |
| 3 | native UI와 Loop admission/effect 연결 | PR2 | 실제 활성화1회·목표2개 사례, revoke/drain·host deny |
| 4 | JEV public capability/지원 판별 계약 | PR1–3 | 두 저장소의 인터페이스·버전·부분 지원 회귀 |
| 5 | 기존 위임 adapter와 owned 취소/결과 연결 | PR4 | 권한 조합 행렬, stale job 결과·이중 종료 방지 |
| 6 | 기준/검증 대응과 근거·복구 UX | PR3, PR5 | 실제 누락 근거를 수정하는 재작업 사례, 한계 구분 |
| 7 | 실제 두 모드 E2E·지원 버전 행렬 | PR3–6 | 실제 승인/검증/JEV/worker/회수 결과, 음성 통제 |
| 8 | RC 문서·패키지·업데이트/복구·stable API | PR7 | 전체 gate, 공개 다운로드·재빌드·설치·rollback 안내 |

v1까지 초기 분해는 8개 정도의 작은 주제 PR이다. 상태 조회 API의 실제 지원 여부와
0.2 시험 결과에 따라 다시 나눈다. 날짜나 병렬 인원 수를 근거 없이 고정하지 않는다.

## 10. 검증 행렬

| 경우 | 반드시 관찰할 결과 |
| --- | --- |
| 요청 모드 full, 실제 grant 없음 | 승인/생성/검증/전송 효과0, 명확한 활성화 안내 |
| 활성화 거절·누락·stale 응답 | FullLive 아님, 컨트롤러 생성 없음 |
| FullLive + 범위 내 fixed/adaptive 목표 | 정책 고정, 유한 hard envelope, 반복 설정 확인 축소 |
| 생성/검증/전송 중 경로·세대 변경 | 다음 효과/CAS 차단, owned 작업 취소·회수 |
| revoke와 admission 경쟁 | stale grant로 새 작업/검증/worker 시작 불가 |
| 검증 nonzero 후 수리 | 같은 목표·명령·hard 한도 안의 통상 재작업 |
| JEV malformed/실패/needs_user | 성공 아님, 기존 정확한 handoff/실패 규칙 유지 |
| 늦은 worker 결과 | 현재 job/controller identity 불일치 시 상태 보존 |
| 마지막 fire·운영 checkpoint·hard expiry | 각각의 기존 경계 유지, 자동 갱신/부활 없음 |
| Loop Full과 JEV Full의 부분 조합 | 권한 대여·조용한 강등·다른 엔진 우회 없음 |
| 저장소 재로딩·compaction·세션 전환 | 의도와 grant 분리, live 권한 복원 없음 |
| 짧은/긴 화면·dark/light·no-color | 기본 정보·상세·Esc·취소와 읽기 공간 유지 |
| 기존 데이터에 모드 없음 | Reviewed 통제 유지, 자동 Full migration 없음 |

실제 mode 연결 시험은 비민감한 owned fixture로 수행한다.
모의 승인을 실제 activation이나 완료로 세지 않고, 실제 provider/model/SDK 버전,
시도 수, 반환값과 미실시 항목을 기록한다. 예상하지 못한 실패를 같은 입력의 재요청이나
provider/model 교체로 덮지 않는다.

## 11. 핵심 불변조건과 품질 gate

- 유효한 live grant가 없거나 epoch가 달라지면 새 효과를 시작하지 않는다.
- 범위 변경·폐기·만료가 권한 복원이나 하드 시작/마감 재설정으로 바뀌지 않는다.
- 같은 live owner의 controller/review/job reservation이 중복 효과나 보호된 종료를 만들지 않는다.
  크래시를 넘는 분산 exactly-once 실행은 약속하지 않으며, 불명확한 dispatch는 자동 재실행하지 않는다.
- 읽기전용 상태/화면이 작업을 claim·activate하거나 실행/전달을 추정하지 않는다.
- reducer/store 소유권을 유지하고 TaskStore와 LoopStore의 교차 트랜잭션을 만들지 않는다.
- 취소 후 drain·프로세스 reaping과 callback 무효화를 확인하고 remote 종료는 추정하지 않는다.
- native UI와 실제 사용 환경을 에이전트가 직접 점검하되 사람 설문 점수를 만들지 않는다.

모든 PR tip에서 기존 `lint/typecheck/test/property/coverage/build/package/audit/diff`
gate를 유지한다. 함수 커버리지 96%는 낮추지 않는다. 새 상태 전이는 생성 속성과
최소 결정적 회귀를 함께 검증한다. 버그는 기존 구현에서 의미 있는 red와 통제를 먼저,
기능은 observable expectation을 먼저 작성한다. 컴파일/fixture/환경 실패를 제품 버그
재현이나 실제 live acceptance 통과로 바꾸지 않는다.

기본 실행 순서는 현재 프로젝트의 다음 명령을 기준으로 한다.

```bash
npm run lint
npm run typecheck
npm test
npm run test:property
npm run test:coverage
npm run build
npm run test:package
npm audit --audit-level=moderate
git diff --check
```

Native TUI·실제 JEV/worker 시험은 해당 변경의 추가 gate다. 외부 효과가 있는 live
시험은 정확한 현재 승인 아래 별도로 실행하고, unavailable 또는 SKIP를 pass로 쓰지 않는다.

## 12. 주요 위험과 대응

| 위험 | 대응 |
| --- | --- |
| Full이라는 이름이 OS/호스트 권한까지 있다고 오해됨 | 같은 OS 사용자·샌드박스 아님·host deny 유지와 실제 범위를 활성화 UI에 표시 |
| 두 확장의 상태/버전이 다름 | 공개 지원 판별, 부분 상태 표시, 실행 소유자의 최종 재검증 |
| 폐기 도중 callback이 새 효과를 시작함 | admission 먼저 차단, epoch/snapshot 재검사, drain 전 재활성화 금지 |
| 검증 범위 밖 기준 때문에 끝없는 unmet | 생성 전에 기준/검증 대응, 실제 누락 진단, 임의 기준 하향이나 재문구화 금지 |
| 공유 프로젝트에서 중복 스케줄링 | v1 Full은 세션 저장소 우선; 소유권 선출 없이 확대하지 않음 |
| SDK/의존성 보안·버전 충돌 | 지원 행렬·감사·호환 패치·깨끗한 설치 검증, 강제 SDK downgrade 금지 |
| mode 도입이 기존 승인을 몰래 바꿈 | 필드 생략 Reviewed, inert metadata, 기존 목표 자동 전환 금지 |

## 13. 롤아웃과 v1 출구 체크리스트

기능은 기본 꺼짐/Reviewed로 배포한다. 0.2에서 Loop만, 0.3에서 지원되는 위임 연동,
0.9에서 공개 RC로 넓힌다. 문제가 있으면 새 Full admission을 막고 소유 작업을
회수한 뒤 컨트롤러를 보존한다. 패키지 rollback이나 저장소 상태가 grant를 되살리지는 않는다.

- [ ] Reviewed 회귀와 fixed/adaptive budget invariants가 유지된다.
- [ ] 한 번의 실제 활성화가 범위 내 복수 목표에서 반복 확인을 실제로 줄인다.
- [ ] 두 소유자의 grant와 부분 상태·철회·오류를 실제 환경에서 구분한다.
- [ ] 검증·JEV·보호된 종료의 양성 사례와 음성/복구 통제가 모두 있다.
- [ ] native UI의 작은/큰 화면, 테마, 키보드·취소 동선과 자원 회수를 점검했다.
- [ ] 지원 public API/schema와 호스트/worker SDK 조합이 문서와 일치한다.
- [ ] 공개 패키지·서명·해시·독립 재빌드·깨끗한 설치/업데이트/복구가 검증됐다.
- [ ] 미실시 플랫폼·사람 연구·remote quiescence 같은 한계가 사실대로 남아 있다.

로드맵 작성은 코드 구현, `main` 병합, 모드 활성화, 계정/전역 설정 변경이나 릴리스
승인이 아니다. 실제 작업과 live 시험·권한/배포 변경은 각 단계의 적용 가능한 승인을 따른다.
