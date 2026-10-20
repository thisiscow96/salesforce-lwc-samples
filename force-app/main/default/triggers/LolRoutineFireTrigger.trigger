// 실행 신호 이벤트 구독: 로직은 LolRoutineFire에 위임 (트리거에는 로직을 두지 않음)
trigger LolRoutineFireTrigger on LoL_Routine_Fire__e (after insert) {
    LolRoutineFire.handleEvents(Trigger.new);
}
