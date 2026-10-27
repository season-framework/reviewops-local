export function reviewNextAction(reviewStatus, runStatus) {
  if (['running','queued'].includes(runStatus)) return '에이전트 작업이 진행 중입니다. 실행 결과를 기다리십시오.';
  if (reviewStatus === 'closed') return '추가 조치 없이 종료한 리뷰입니다. 수정이 필요하면 상태를 재검토로 변경하십시오.';
  if (reviewStatus === 'resolved') return '작업자 검토를 마쳤습니다. 작성자는 결과를 확인한 뒤 닫힘 또는 재검토로 변경하십시오.';
  if (['failed','cancelled','interrupted'].includes(runStatus)) return '작업자는 실행 결과와 변경된 파일을 확인한 뒤 다시 요청하거나 종료 사유를 작업이력에 남기십시오.';
  if (runStatus === 'completed') return '작업자는 결과를 검토한 뒤 해결로 변경하십시오. 해결은 작성자의 확인을 기다리는 상태입니다.';
  return '작업자는 요청을 검토하고 필요한 작업을 실행하십시오.';
}
