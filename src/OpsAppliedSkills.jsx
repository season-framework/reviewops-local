import React from 'react';
import {t} from './i18n/index.js';
import './OpsSkillsSettings.css';
export default function OpsAppliedSkills({snapshot,compact=false}){
 if(!snapshot)return null;
 return <div className={`ops-applied-skills${compact?' compact':''}`} aria-label={t('적용한 스킬')}><strong>{t('적용한 스킬')}</strong>{snapshot.skills?.length?<ul>{snapshot.skills.map(skill=><li key={skill.id} title={skill.revision}>{skill.name} <span>{skill.version||t('버전 미지정')} · {skill.revision.slice(0,12)}</span></li>)}</ul>:<span>{t('선택한 스킬 없음')}</span>}{!compact&&<small>{t('이 요청이 시작될 때의 지침과 참조 파일을 유지합니다.')}</small>}</div>;
}
