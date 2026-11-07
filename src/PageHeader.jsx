import React from 'react';
import './page-header.css';

// Page identity stays on the same baseline as its controls. Optional context is
// inline and omitted entirely when absent, so an empty subtitle reserves no row.
export default function PageHeader({title,subtitle,meta,leading,actions,controls,children,className='',identityClassName='',actionsClassName='',headingLevel=1,variant='page',titleHint}) {
 const Heading=`h${headingLevel}`;
 return <header className={`reviewops-page-header reviewops-page-header--${variant} ${className}`} data-page-header={variant}>
  <div className={`page-header-identity ${identityClassName}`}>
   {leading&&<div className="page-header-leading">{leading}</div>}
   <Heading className="page-header-title" title={titleHint||(typeof title==='string'?title:undefined)}>{title}</Heading>
   {meta!==undefined&&meta!==null&&meta!==''&&<span className="page-header-meta">{meta}</span>}
   {subtitle&&<div className="page-header-context" title={typeof subtitle==='string'?subtitle:undefined}>{subtitle}</div>}
  </div>
  {controls&&<div className="page-header-controls">{controls}</div>}
  {actions&&<div className={`page-header-actions ${actionsClassName}`}>{actions}</div>}
  {children&&<div className="page-header-secondary">{children}</div>}
 </header>;
}
