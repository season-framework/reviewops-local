import {t,getLocale} from '../i18n/index.js';
import React, { useEffect, useRef, useState } from 'react';
import Select from '../Select.jsx';
import { CircleHelp, ExternalLink, Loader2, LogIn, MoreHorizontal, Plus, RefreshCw, Server, Ticket, Users, X } from 'lucide-react';
import { AccountDetails } from './AccountDetails';
import { ActionButton } from './ActionButton';
import { HostManager } from './HostManager';
import { ResetCreditPicker, isResetCreditSelectable, resetCreditDate, resetCreditTitle } from './ResetCreditPicker';
import './styles.css';

const bridge = window.accountManager;
const hostBridge = window.hostManager;
const emptyState = { accounts: [], refresh: { running: false }, runtime: { available: false } };
const integer = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString(getLocale()) : '—';
const dateText = value => {
  if (!value) return '—';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};
function buckets(account) {
  const values = Object.values(account.usage?.rateLimitsByLimitId || {}).filter(Boolean);
  return values.length ? values : account.usage?.rateLimits ? [account.usage.rateLimits] : [];
}
function creditBalance(account) {
  const all = buckets(account);
  const credits = (all.find(item => item.limitId === 'codex') || all[0])?.credits ?? account.usage?.rateLimits?.credits;
  if (!credits) return '—';
  if (credits.unlimited) return t("무제한");
  if (credits.balance != null && credits.balance !== '') {
    const number = Number(credits.balance);
    return integer(number);
  }
  return credits.hasCredits === false ? '0' : '—';
}
const resetCount = account => {
  const value = account.usage?.rateLimitResetCredits?.availableCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};
const busy = account => ['loading', 'loggingIn'].includes(account.status) || account.resetAttempt?.status === 'pending';
const needsRead = account => account.resetAttempt?.status === 'completed' && account.resetAttempt.needsRefresh;
const canReset = account => !account.requiresLogin && !busy(account) && !account.warning && !account.error && !needsRead(account) && account.status === 'ready' && account.resetAttempt?.status !== 'uncertain' && resetCount(account) > 0;
const canOpenResetList = account => !account.requiresLogin && !['loggingIn', 'signedOut'].includes(account.status) && account.resetAttempt?.status !== 'pending';
const canRetry = account => !account.requiresLogin && account.resetAttempt?.status === 'uncertain' && !busy(account);
const period = window => {
  const mins = window?.windowDurationMins;
  if (!mins) return t("사용량");
  if (mins === 10080) return t("주간");
  if (mins === 1440) return t("일간");
  return mins % 60 !== 0 ? t("{0}분",[integer(mins)]) : mins % 1440 === 0 ? t("{0}일",[integer(mins / 1440)]) : t("{0}시간",[integer(mins / 60)]);
};

function Modal({ title, children, footer, onClose, alert = false, wide = false }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const targets = () => [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')].filter(node => node.tabIndex >= 0 && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && node.getAttribute('aria-hidden') !== 'true');
    targets()[0]?.focus();
    const keydown = event => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab') return;
      const items = targets();
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><section ref={ref} className={`modal ${wide ? 'wide' : ''}`} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="dialog-title">
    <div className="modal-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label={t("닫기")} onClick={onClose}><X size={18}/></button></div>
    <div className="modal-body">{children}</div><div className="modal-footer">{footer}</div>
  </section></div>;
}

function Usage({ account }) {
  const all = buckets(account);
  return <div className="usage-list">{(all.length ? all : [{}]).map((bucket, index) => <div key={bucket.limitId || index}>
    {all.length > 1 && <div className="bucket-name">{bucket.limitName || bucket.limitId || 'Codex'}</div>}
    <div className="usage-windows">{[bucket.primary, bucket.secondary].map((window, i) => {
      const value = typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null;
      return <div className="usage-cell" key={i}><div className={`usage-value ${value !== null && value <= 15 ? 'low' : ''}`}><span>{period(window)}</span><strong>{value === null ? '—' : `${integer(value)}%`}</strong>{value !== null && <span>{t("남음")}</span>}</div>{window?.resetsAt > 0 && <small>{dateText(window.resetsAt)}{" "+t("갱신")}</small>}</div>;
    })}</div>
  </div>)}</div>;
}

export function AccountApp() {
  const [state, setState] = useState(emptyState);
  const [selected, setSelected] = useState(new Set());
  const [modal, setModal] = useState(null);
  const [label, setLabel] = useState('');
  const [method, setMethod] = useState('chatgpt');
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState(null);
  const apply = snapshot => {
    if (!snapshot?.accounts) return;
    setState({ ...emptyState, ...snapshot });
    setModal(previous => {
      if (!previous?.readPendingIds?.length) return previous;
      const pendingIds = previous.readPendingIds.filter(id => {
        const account = snapshot.accounts.find(item => item.id === id);
        return account && account.lastUpdated === previous.readBaseline[id] && !['error', 'signedOut'].includes(account.status);
      });
      return pendingIds.length === previous.readPendingIds.length ? previous : { ...previous, readPendingIds: pendingIds };
    });
  };
  const run = async (action, close = false) => {
    try { const result = await action(); apply(result); if (close) setModal(null); return result; }
    catch (error) { setNotice(error.message || t("작업을 완료하지 못했습니다.")); return null; }
  };
  useEffect(() => {
    if (!bridge) return;
    run(() => bridge.getState());
    return bridge.onState(apply);
  }, []);
  useEffect(() => {
    setSelected(previous => new Set([...previous].filter(id => state.accounts.some(account => account.id === id))));
    if (modal?.type === 'login' && state.accounts.some(account => account.id === modal.id && account.status === 'ready' && !account.login)) setModal(null);
    if (['resetPicker', 'reset'].includes(modal?.type)) {
      setModal(previous => {
        if (!['resetPicker', 'reset'].includes(previous?.type)) return previous;
        const selections = Object.fromEntries(Object.entries(previous.selections || {}).filter(([id, creditId]) => {
          const account = state.accounts.find(item => item.id === id);
          return account && account.email === previous.accountEmails[id] && (account.usage?.rateLimitResetCredits?.credits || []).some(credit => credit.id === creditId && isResetCreditSelectable(credit));
        }));
        return Object.keys(selections).length === Object.keys(previous.selections || {}).length ? previous : { ...previous, selections };
      });
    }
  }, [state.accounts]);
  useEffect(() => {
    if (!menu) return;
    const close = event => { if (event.key === 'Escape' || (event.type === 'click' && !event.target.closest('.account-actions'))) setMenu(null); };
    document.addEventListener('click', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', close); };
  }, [menu]);
  if (!bridge) return <main className="launch-screen"><h1>{t("계정관리")}</h1><p>{t("계정 관리 기능은 데스크톱 앱에서 사용할 수 있습니다.")}</p><code>npm run dev</code></main>;

  const accounts = state.accounts;
  const selectedAccounts = accounts.filter(account => selected.has(account.id));
  const eligible = selectedAccounts.filter(canOpenResetList);
  const target = modal?.id ? accounts.find(account => account.id === modal.id) : null;
  const resetTargets = accounts.filter(account => modal?.ids?.includes(account.id));
  const pickerTargets = accounts.filter(account => modal?.pickerIds?.includes(account.id));
  const retry = modal?.type === 'retry';
  const canSelectReset = account => canReset(account) && !(modal?.readPendingIds || []).includes(account.id) && account.email === modal?.accountEmails?.[account.id];
  const selectedCredit = account => account.usage?.rateLimitResetCredits?.credits?.find(credit => credit.id === modal?.selections?.[account.id]);
  const selectedResetAccounts = pickerTargets.filter(account => canSelectReset(account) && isResetCreditSelectable(selectedCredit(account)));
  const confirmEnabled = resetTargets.length > 0 && resetTargets.length === modal?.ids?.length && resetTargets.every(retry ? canRetry : account => canSelectReset(account) && isResetCreditSelectable(selectedCredit(account)));
  const openAdd = () => { setLabel(''); setMethod('chatgpt'); setModal({ type: 'add' }); };
  const startLogin = async id => { setModal({ type: 'login', id }); await run(() => bridge.login(id, method)); };
  const refreshResetList = async picker => {
    const readBaseline = Object.fromEntries(accounts.filter(account => picker.pickerIds.includes(account.id)).map(account => [account.id, account.lastUpdated]));
    setModal(previous => previous?.session === picker.session ? { ...previous, refreshing: true, error: '', readBaseline, readPendingIds: [...picker.pickerIds] } : previous);
    try {
      const result = await bridge.refreshAccounts(picker.pickerIds);
      if (!result?.accounts) throw new Error(t("초기화권 목록을 조회하지 못했습니다."));
      apply(result);
      setModal(previous => previous?.session === picker.session ? { ...previous, refreshing: false, readPendingIds: [] } : previous);
    } catch (error) {
      setModal(previous => previous?.session === picker.session ? { ...previous, refreshing: false, error: error.message || t("초기화권 목록을 조회하지 못했습니다.") } : previous);
    }
  };
  const openResetList = ids => {
    const picker = { type: 'resetPicker', ids, pickerIds: ids, selections: {}, session: crypto.randomUUID(), accountEmails: Object.fromEntries(accounts.filter(account => ids.includes(account.id)).map(account => [account.id, account.email])), refreshing: true, readPendingIds: ids, readBaseline: Object.fromEntries(accounts.filter(account => ids.includes(account.id)).map(account => [account.id, account.lastUpdated])) };
    setMenu(null); setModal(picker); refreshResetList(picker);
  };
  const addAccount = async event => {
    event.preventDefault(); setWorking(true);
    const previous = new Set(accounts.map(account => account.id));
    const result = await run(() => bridge.addAccount(label.trim() || t("새 계정")));
    const added = result?.accounts.find(account => !previous.has(account.id));
    if (added) await startLogin(added.id);
    setWorking(false);
  };
  const confirmReset = async () => {
    if (!confirmEnabled || working) return;
    if (!retry && !resetTargets.every(account => canSelectReset(account) && isResetCreditSelectable(selectedCredit(account)))) {
      setModal(previous => ({ ...previous, type: 'resetPicker', ids: previous.pickerIds }));
      return;
    }
    setWorking(true);
    const ids = resetTargets.map(account => account.id);
    await run(() => retry ? bridge.resetAccounts(ids) : bridge.resetAccounts(ids, Object.fromEntries(ids.map(id => [id, modal.selections[id]]))), true);
    setWorking(false);
  };

  return <main className="account-app">
    <header className="toolbar"><h1>{t("계정")+" "}<span aria-hidden="true">{accounts.length}</span></h1><div className="toolbar-actions">

      <ActionButton label={t("새로고침")} icon={RefreshCw} busy={state.refresh.running} disabled={!accounts.length || accounts.every(account => account.requiresLogin) || state.refresh.running} onClick={() => run(() => bridge.refreshAccounts())}/>
      <ActionButton label={t("계정 추가")} icon={Plus} className="primary" onClick={openAdd}/>
    </div></header>
    {notice && <div className="notice" role="alert"><span>{notice}</span><button className="icon-button" aria-label={t("알림 닫기")} onClick={() => setNotice('')}><X size={16}/></button></div>}
    {accounts.some(account => account.requiresLogin) && <div className="runtime-notice" role="status"><span>{t("가져온 계정")+" "}{accounts.filter(account => account.requiresLogin).length}{t("개는 다시 로그인해야 합니다. 저장된 사용량과 통계는 유지됩니다.")}</span></div>}
    {!state.runtime.available && <div className="runtime-notice"><span>{state.runtime.error || t("Codex 실행 파일이 필요합니다.")}</span><button className="button" onClick={() => run(() => bridge.chooseCodexBinary())}>{t("실행 파일 선택")}</button></div>}
    {selected.size > 0 && <div className="selection-bar"><span>{selected.size}{t("개 선택")}</span><ActionButton label={t("선택 새로고침")} icon={RefreshCw} busy={selectedAccounts.some(account => account.status === 'loading')} disabled={selectedAccounts.every(account => busy(account) || account.requiresLogin)} onClick={() => run(() => bridge.refreshAccounts([...selected]))}/><ActionButton label={t("선택 계정 초기화권 사용")} icon={Ticket} disabled={!eligible.length} onClick={() => openResetList(eligible.map(account => account.id))}/><ActionButton label={t("선택 해제")} icon={X} className="deselect" onClick={() => setSelected(new Set())}/></div>}
    <div className="table-scroll"><table aria-label={t("계정 목록")}><thead><tr>
      <th className="check-col"><input type="checkbox" aria-label={t("모든 계정 선택")} disabled={!accounts.length} checked={accounts.length > 0 && selected.size === accounts.length} onChange={() => setSelected(selected.size === accounts.length ? new Set() : new Set(accounts.map(account => account.id)))}/></th>
      <th className="account-col">{t("계정")}</th><th className="usage-col numeric">{t("사용량")}</th><th className="balance-col numeric">{t("크레딧")}</th><th className="reset-col numeric">{t("초기화권")}</th><th className="actions-col">{t("작업")}</th>
    </tr></thead><tbody>{accounts.map(account => <tr key={account.id} className={selected.has(account.id) ? 'selected' : ''}>
      <td><input type="checkbox" aria-label={t("{0} 선택",[account.label])} checked={selected.has(account.id)} onChange={() => setSelected(previous => { const next = new Set(previous); next.has(account.id) ? next.delete(account.id) : next.add(account.id); return next; })}/></td>
      <td className="account-col"><button className="account-info" aria-label={t("{0} 상세 통계",[account.label])} onClick={() => { setMenu(null); setModal({ type: 'details', id: account.id }); }}><span className="account-name"><strong>{account.label}</strong>{account.planType && <span className="plan">{account.planType}</span>}</span><span className="email">{account.email || t("로그인 전")}</span></button>
        <small className="account-status">{account.status === 'loggingIn' ? t("로그인 중") : account.requiresLogin ? t("다시 로그인 필요") : account.status === 'loading' ? t("조회 중") : account.status === 'signedOut' ? t("로그인 필요") : account.lastUpdated ? t("{0} 조회",[dateText(account.lastUpdated)]) : t("조회 전")}</small>
        {(account.error || account.warning) && <p className="row-error">{account.error || account.warning}</p>}
        {account.resetAttempt?.message && <p className="row-result" role="status">{account.resetAttempt.message}</p>}
      </td>
      <td className="numeric"><Usage account={account}/></td>
      <td className="numeric"><span className="credit-balance">{creditBalance(account)}</span>{creditBalance(account) === '—' && <small className="muted">{t("정보 없음")}</small>}</td>
      <td className="numeric"><div className="reset-cell"><button className="credit-value reset-list-entry" aria-label={t("{0} 초기화권 목록",[account.label])} disabled={!canOpenResetList(account)} onClick={() => openResetList([account.id])}><b>{integer(resetCount(account))}</b>{resetCount(account) !== null && <span>{t("개")}</span>}</button>
        {account.resetAttempt?.status === 'pending' ? <ActionButton label={t("초기화권 적용 중")} icon={Ticket} busy disabled/>
          : needsRead(account) ? <ActionButton label={t("사용량 새로고침")} tooltip={t("사용량 새로고침")} icon={RefreshCw} busy={account.status === 'loading'} disabled={busy(account) || account.requiresLogin} onClick={() => run(() => bridge.refreshAccounts([account.id]))}/>
            : account.resetAttempt?.status === 'uncertain' ? <ActionButton label={t("결과 다시 확인")} tooltip={t("초기화 결과 다시 확인")} icon={CircleHelp} disabled={!canRetry(account)} onClick={() => setModal({ type: 'retry', ids: [account.id] })}/>
              : <ActionButton label={t("초기화권 사용")} tooltip={t("초기화권 사용")} icon={Ticket} disabled={!canOpenResetList(account)} onClick={() => openResetList([account.id])}/>}
      </div></td>
      <td><div className="account-actions">{account.requiresLogin || ['signedOut', 'loggingIn'].includes(account.status) ? <ActionButton label={t("로그인")} tooltip={t("로그인")} icon={LogIn} busy={account.status === 'loggingIn'} onClick={() => account.login ? setModal({ type: 'login', id: account.id }) : startLogin(account.id)}/> : <ActionButton label={t("{0} 새로고침",[account.label])} tooltip={t("새로고침")} icon={RefreshCw} busy={account.status === 'loading'} disabled={busy(account)} onClick={() => run(() => bridge.refreshAccounts([account.id]))}/>}
        <ActionButton label={t("{0} 메뉴",[account.label])} tooltip={t("더 보기")} icon={MoreHorizontal} aria-expanded={menu === account.id} onClick={() => setMenu(menu === account.id ? null : account.id)}/>
        {menu === account.id && <div className="dropdown reviewops-popup-menu"><button onClick={() => { setLabel(account.label); setModal({ type: 'rename', id: account.id }); setMenu(null); }}>{t("이름 변경")}</button><button onClick={() => { startLogin(account.id); setMenu(null); }}>{t("다시 로그인")}</button><button className="danger-text" onClick={() => { setModal({ type: 'remove', id: account.id }); setMenu(null); }}>{t("계정 삭제")}</button></div>}
      </div></td>
    </tr>)}{!accounts.length && <tr><td colSpan={6} className="empty">{t("등록된 계정이 없습니다.")}</td></tr>}</tbody></table></div>

    {modal?.type === 'details' && target && <Modal wide title={t("{0} 상세 통계",[target.label])} onClose={() => setModal(null)} footer={<button className="button" onClick={() => setModal(null)}>{t("닫기")}</button>}><AccountDetails account={target} bridge={bridge}/></Modal>}
    {modal?.type === 'add' && <Modal title={t("계정 추가")} onClose={() => !working && setModal(null)} footer={<><button className="button" disabled={working} onClick={() => setModal(null)}>{t("취소")}</button><button form="add-form" type="submit" className="button primary" disabled={working || !state.runtime.available}>{t("로그인 시작")}</button></>}>
      <form id="add-form" onSubmit={addAccount}><label htmlFor="account-label">{t("계정 이름")}</label><input id="account-label" maxLength={60} placeholder={t("예: 개인 계정")} value={label} onChange={event => setLabel(event.target.value)}/><label htmlFor="login-method">{t("로그인 방식")}</label><Select id="login-method" searchable={false} value={method} onChange={event => setMethod(event.target.value)}><option value="chatgpt">{t("브라우저 로그인")}</option><option value="chatgptDeviceCode">{t("기기 코드로 로그인")}</option></Select></form>
    </Modal>}
    {modal?.type === 'login' && <Modal title={t("계정 로그인")} onClose={() => setModal(null)} footer={<><button className="button" onClick={() => run(() => bridge.cancelLogin(modal.id), true)}>{t("로그인 취소")}</button>{target?.login?.url && <button className="button primary" onClick={() => run(() => bridge.openLogin(modal.id))}><ExternalLink size={15}/>{t("로그인 페이지 열기")}</button>}</>}>
      <p>{target?.error || t("브라우저에서 사용할 계정으로 로그인하십시오.")}</p>{target?.status !== 'error' && <Loader2 className="spin login-spinner" size={22}/>}{target?.login?.userCode && <div className="device-code" aria-label={t("로그인 코드")}>{target.login.userCode}</div>}
    </Modal>}
    {modal?.type === 'resetPicker' && <Modal wide title={t("초기화권 목록")} onClose={() => setModal(null)} footer={<><button className="button" onClick={() => setModal(null)}>{t("취소")}</button><button className="button primary" disabled={!selectedResetAccounts.length} onClick={() => setModal(previous => ({ ...previous, type: 'reset', ids: selectedResetAccounts.map(account => account.id) }))}>{t("선택 완료")}</button></>}>
      <ResetCreditPicker accounts={pickerTargets} selections={modal.selections} pendingIds={modal.readPendingIds || []} refreshing={modal.refreshing} error={modal.error} selectable={canSelectReset} onSelect={(id, creditId) => setModal(previous => ({ ...previous, selections: { ...previous.selections, [id]: creditId } }))} onRefresh={() => refreshResetList(modal)}/>
    </Modal>}
    {['reset', 'retry'].includes(modal?.type) && <Modal alert title={retry ? t("초기화 결과 확인") : t("초기화권 사용 확인")} onClose={() => !working && setModal(null)} footer={<><button className="button" disabled={working} onClick={() => setModal(null)}>{t("취소")}</button><button className="button primary" disabled={working || !confirmEnabled} onClick={confirmReset}>{working ? t("처리 중") : retry ? t("계속") : t("사용")}</button></>}>
      <p>{retry ? t("이전에 보낸 초기화 요청을 다시 처리합니다. 같은 요청 번호를 사용하며, 아직 처리되지 않았다면 초기화권이 사용됩니다.") : t("선택한 계정마다 초기화권 1개를 사용합니다.")}</p>
      <div className="reset-account-list">{resetTargets.map(account => <div key={account.id}><strong>{account.label}</strong><span>{account.email}</span>{!retry && selectedCredit(account) && <div className="reset-confirm-credit"><span className="reset-confirm-title">{resetCreditTitle(selectedCredit(account))}</span><div className="reset-confirm-date"><span>{t("발급")}</span><span>{resetCreditDate(selectedCredit(account).grantedAt)}</span></div><div className="reset-confirm-date"><span>{t("만료")}</span><span>{resetCreditDate(selectedCredit(account).expiresAt, true)}</span></div></div>}</div>)}</div>
      {!retry && <p className="muted">{t("사용한 초기화권은 되돌릴 수 없습니다.")}</p>}
      {!retry && <button className="text-button" disabled={working} onClick={() => setModal(previous => ({ ...previous, type: 'resetPicker', ids: previous.pickerIds }))}>{t("목록으로 돌아가기")}</button>}
    </Modal>}
    {modal?.type === 'rename' && <Modal title={t("계정 이름 변경")} onClose={() => setModal(null)} footer={<><button className="button" onClick={() => setModal(null)}>{t("취소")}</button><button className="button primary" onClick={() => run(() => bridge.renameAccount(modal.id, label.trim() || t("새 계정")), true)}>{t("저장")}</button></>}><label htmlFor="rename-label">{t("계정 이름")}</label><input id="rename-label" value={label} maxLength={60} onChange={event => setLabel(event.target.value)}/></Modal>}
    {modal?.type === 'remove' && <Modal title={t("계정 삭제")} onClose={() => setModal(null)} footer={<><button className="button" onClick={() => setModal(null)}>{t("취소")}</button><button className="button danger" onClick={() => run(() => bridge.removeAccount(modal.id), true)}>{t("계정 삭제")}</button></>}><p><strong>{target?.label}</strong>{t("을 목록에서 삭제합니다. 이 앱에 저장된 해당 계정의 로그인 정보도 삭제됩니다.")}</p></Modal>}
  </main>;
}

export function CodexManagement({ page = 'accounts' }) {
  return <div className="codex-management codex-management-page"><div className="manager-content">{page === 'hosts' ? <HostManager bridge={hostBridge}/> : <AccountApp/>}</div></div>;
}
