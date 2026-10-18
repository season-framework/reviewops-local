import React from 'react';
import Select from './Select.jsx';
import {LANGUAGES,getLocale,setLocale,t,useLocale} from './i18n/index.js';
import './language-settings.css';

export default function LanguageSettings() {
 useLocale();
 return <section className="settings-panel language-settings" aria-label={t('언어 설정')}>
  <div className="section-heading"><h2>{t('언어')}</h2></div>
  <p>{t('화면에 표시할 언어를 선택합니다. 변경 사항은 바로 적용됩니다.')}</p>
  <label className="field"><span>{t('표시 언어')}</span>
   <Select id="reviewops-language" searchable aria-label={t('표시 언어')} value={getLocale()} onChange={event=>setLocale(event.target.value)} searchPlaceholder={t('언어 검색')}>
    {LANGUAGES.map(language=><option key={language.code} value={language.code}>{language.name}{language.name===language.english?'':` · ${language.english}`}</option>)}
   </Select>
  </label>
  <p className="muted">{t('번역이 없는 항목은 영어로 표시합니다. 프로젝트 이름, 리뷰 내용, 파일과 로그는 원문을 유지합니다.')}</p>
 </section>;
}
