#!/usr/bin/env python3
"""Build full-window screenshot flows with separate editable HWPX annotations.
Usage: python build_report.py content.json output.hwpx
"""
from pathlib import Path
from datetime import datetime, timezone
import sys, json, warnings, zipfile, hashlib
from hwpx import HwpxDocument
from hwpx.oxml import ContainerMember
from hwpx.layout.pages import estimate_pages
from PIL import Image
warnings.filterwarnings('ignore', category=DeprecationWarning)
BLUE='#111111'; INK='#161616'; GRAY='#555555'; LIGHT='#EFEFEF'; BORDER='#B8B8B8'
MM=7200/25.4
class Report:
 def __init__(self,data):
  self.data=data; self.doc=HwpxDocument.new(); self.styles={};self.counts={'planned_pages':0,'tables':0,'images':0,'annotation_boxes':0,'annotation_numbers':0};self.annotation_warnings=[]
  # Normalize the unused template heading style as well as the report styles.
  for header in self.doc.headers:
   for element in header.element.iter():
    if element.get('textColor')=='#2E74B5':element.set('textColor',BLUE)
   header.mark_dirty()
  stamp=datetime.now(timezone.utc).isoformat()
  self.doc.package.clear_document_metadata(timestamp=stamp)
  self.doc.package.set_document_metadata(title=data.get('document_title','QA 및 사용성 평가 보고서'),creator='Codex',created_date=stamp,modified_date=stamp)
  self.doc.set_page_setup(paper_size='A4',margin_left_mm=18,margin_right_mm=18,margin_top_mm=16,margin_bottom_mm=16,header_margin_mm=8,footer_margin_mm=8)
  self.header=self.doc.set_header_text(data.get('header','QA 및 사용성 평가'))
  self.footer=self.doc.set_page_number(position='BOTTOM_RIGHT',align='RIGHT',prefix='',suffix='')
  self.doc.sections[0].properties.set_visibility(hide_first_header=True,hide_first_footer=True,hide_first_page_num=True)
  for name,size,bold,color in [('body',10,False,INK),('small',8.5,False,GRAY),('caption',8.5,False,GRAY),('title',18,True,BLUE),('cover',32,True,BLUE),('subtitle',15,False,INK),('h2',11,True,BLUE),('label',9,True,BLUE),('table',9,False,INK),('thead',9,True,BLUE),('step',11,True,BLUE),('flow_caption',10,False,INK),('annotation',11,True,'#FFFFFF')]:
   self.styles[name]=self.doc.ensure_run_style(font=self.data.get('font','맑은 고딕'),size=size,bold=bold,color=color)
  # Initial paragraph carries section settings; keep it and minimize vertical space.
  p=self.doc.paragraphs[0];p.char_pr_id_ref=self.doc.ensure_run_style(font=self.data.get('font','맑은 고딕'),size=1)
  self.doc.set_paragraph_format(paragraph_index=0,line_spacing_percent=100,spacing_after_pt=0)
  self.para_styles={}
  for name,kw in {'body':dict(alignment='LEFT',line_spacing_percent=145,spacing_after_pt=4,keep_lines=True), 'table':dict(alignment='LEFT',line_spacing_percent=135,spacing_after_pt=1,keep_lines=True),'caption':dict(line_spacing_percent=130,spacing_after_pt=7,keep_lines=True),'title':dict(line_spacing_percent=125,spacing_before_pt=0,spacing_after_pt=12,keep_with_next=True), 'small':dict(line_spacing_percent=130,spacing_after_pt=3,keep_lines=True), 'heading':dict(line_spacing_percent=130,spacing_before_pt=8,spacing_after_pt=5,keep_with_next=True)}.items():
   p=self.doc.add_paragraph('');self.doc.set_paragraph_format(paragraph_index=len(self.doc.paragraphs)-1,**kw);self.para_styles[name]=p.para_pr_id_ref;p.remove()
  for hf in [self.header,self.footer]:
   for p in hf.paragraphs:
    for run in p.runs:run.char_pr_id_ref=self.styles['small']
  p=self.doc.add_paragraph('');self.doc.set_paragraph_format(paragraph_index=len(self.doc.paragraphs)-1,alignment='CENTER',line_spacing_percent=100,spacing_before_pt=0,spacing_after_pt=0);self.para_styles['annotation']=p.para_pr_id_ref;p.remove()
  self.first_content=True
 def p(self,text,style='body',pagebreak=False,**kw):
  if self.first_content:
   p=self.doc.paragraphs[0];p.para_pr_id_ref=self.para_styles.get(style,self.para_styles['body']);p.add_run(str(text),char_pr_id_ref=self.styles[style]);self.first_content=False
  else:
   p=self.doc.add_paragraph(str(text),char_pr_id_ref=self.styles[style],para_pr_id_ref=self.para_styles.get(style,self.para_styles['body']),inherit_style=False)
  if pagebreak or kw:self.doc.set_paragraph_format(paragraph_index=len(self.doc.paragraphs)-1,page_break_before=pagebreak,**kw)
  return p
 def table(self,b):
  rows=[b.get('headers',[])]+b.get('rows',[]) if b.get('headers') else b.get('rows',[])
  if not rows:return
  cols=len(rows[0]);width=int(174*MM)
  t=self.doc.add_table(len(rows),cols,width=width,height=int(max(7*len(rows),10)*MM),char_pr_id_ref=self.styles['table'],para_pr_id_ref=self.para_styles['table'],border_fill_id_ref=self.doc.ensure_border_fill(border_color=BORDER,border_width='0.1 mm'))
  t.set_treat_as_char(True);t.set_column_widths(b.get('widths',[1]*cols))
  for r,row in enumerate(rows):
   for c,txt in enumerate(row):
    cell=t.cell(r,c);cell.set_margins(left=int(2*MM),right=int(2*MM),top=int(1.5*MM),bottom=int(1.5*MM));cell.set_text(str(txt))
    for p in cell.paragraphs:
     p.para_pr_id_ref=self.para_styles['table']
     for run in p.runs:run.char_pr_id_ref=self.styles['thead' if r==0 and b.get('headers') else 'table']
    if r==0 and b.get('headers'):t.set_cell_shading(r,c,LIGHT)
  self.counts['tables']+=1
  self.p('',style='small',line_spacing_percent=60,spacing_after_pt=1)
 def image(self,b):
  path=Path(b['path']);im=Image.open(path);w,h=im.size
  width=min(float(b.get('width_mm',174)),174);height=width*h/w
  max_h=float(b.get('max_height_mm',100))
  if height>max_h:width*=max_h/height;height=max_h
  self.doc.add_picture(path.read_bytes(),im.format.lower().replace('jpg','jpeg'),width_mm=width,height_mm=height,align='CENTER',line_color=BORDER,line_width=25,para_pr_id_ref=self.para_styles['caption'])
  self.counts['images']+=1
  if b.get('caption'):self.p(b['caption'],'caption')

 def flow_step(self,b):
  path=Path(b['path']);im=Image.open(path);iw,ih=im.size
  width=min(float(b.get('width_mm',174)),174);height=width*ih/iw
  max_h=float(b.get('max_height_mm',102))
  if height>max_h:width*=max_h/height;height=max_h
  group_w,group_h=round(width*MM),round(height*MM)
  sx,sy=group_w/iw,group_h/ih
  self.p(b['title'],'step',line_spacing_percent=110,spacing_before_pt=0,spacing_after_pt=3,keep_with_next=True)
  image=self.doc.media.add_image(path.read_bytes(),im.format.lower().replace('jpg','jpeg'))
  members=[ContainerMember.picture(0,0,group_w,group_h,image)]
  border=ContainerMember.rect(0,0,group_w,group_h,line_color=BORDER,line_width='25')
  members.append(border)
  marker=round(7*MM)
  placed=[]
  targets=[tuple(round(v*(sx if i%2==0 else sy)) for i,v in enumerate(a['box'])) for a in b.get('annotations',[])]
  def overlaps(a,c):return a[0]<c[0]+c[2] and a[0]+a[2]>c[0] and a[1]<c[1]+c[3] and a[1]+a[3]>c[1]
  for a in b.get('annotations',[]):
   x,y,w,h=a['box']
   if min(x,y)<0 or w<=0 or h<=0 or x+w>iw or y+h>ih:raise ValueError(f'Annotation outside source: {a}')
   rx,ry,rw,rh=round(x*sx),round(y*sy),round(w*sx),round(h*sy)
   # White outer line plus black inner line remains visible on light and dark screenshots.
   halo=ContainerMember.rect(rx,ry,rw,rh,line_color='#FFFFFF',line_width='220')
   members.append(halo)
   members.append(ContainerMember.rect(rx,ry,rw,rh,line_color='#111111',line_width='110'))
   gap=round(1*MM)
   candidates=[(rx-marker-gap,ry),(rx-marker-gap,ry-marker-gap),(rx-marker-gap,ry+rh+gap),(rx,ry-marker-gap),(rx+rw+gap,ry),(rx,ry+rh+gap)]
   candidates += [(rx-marker-gap,m[1]+m[3]+gap) for m in placed]
   if a.get('label_at') is not None:
    label=a['label_at'];candidates=[(round(label[0]*sx),round(label[1]*sy))]
   elif a.get('label_y') is not None:candidates=[(candidates[0][0],round(a['label_y']*sy))]
   safe=[(lx,ly) for lx,ly in candidates if lx>=0 and ly>=0 and lx+marker<=group_w and ly+marker<=group_h and not any(overlaps((lx,ly,marker,marker),t) for t in targets+placed)]
   if safe:lx,ly=safe[0]
   else:
    lx,ly=candidates[0];lx=max(0,min(group_w-marker,lx));ly=max(0,min(group_h-marker,ly))
    self.annotation_warnings.append({'page':self.counts['planned_pages'],'step':b['title'],'number':a['number'],'message':'No unobstructed marker position found. Inspect the native page and set label_at or label_y.'})
   placed.append((lx,ly,marker,marker))
   members.append(ContainerMember.text_box(lx,ly,marker,marker,str(a['number']),line_color='#111111',line_width='70',fill_color='#111111',margin={'left':0,'right':0,'top':0,'bottom':0},char_pr_id_ref=self.styles['annotation'],para_pr_id_ref=self.para_styles['annotation'],vert_align='CENTER'))
   self.counts['annotation_boxes']+=1;self.counts['annotation_numbers']+=1
  p=self.p('',line_spacing_percent=100,spacing_before_pt=0,spacing_after_pt=2,keep_with_next=True)
  self.doc.shapes.add_container(members,paragraph=p,treat_as_char=True)
  self.counts['images']+=1
  self.p(b['caption'],'flow_caption',line_spacing_percent=120,spacing_before_pt=0,spacing_after_pt=5,keep_lines=True)

 def render(self):
  self.counts['planned_pages']=0
  if not self.data.get('omit_cover',False):
   cover=self.data.get('cover',{})
   self.p(cover.get('kicker','검토 결과 보고서'),'label',spacing_before_pt=66,spacing_after_pt=22)
   for line in cover.get('title',['QA 및 사용성 평가','보고서']):self.p(line,'cover',line_spacing_percent=125,spacing_after_pt=10)
   self.p(cover.get('subtitle','이슈별 기능 검증 및 화면 사용성 평가'),'subtitle',spacing_before_pt=12,spacing_after_pt=34)
   self.table({'headers':['항목','내용'],'rows':cover.get('rows',[]),'widths':[1,3]})
   for s in cover.get('notes',[]):self.p('• '+s,'small')
   self.counts['planned_pages']=1
  for page in self.data.get('pages',[]):
   self.counts['planned_pages']+=1
   has_previous=self.counts['planned_pages']>1
   if not page.get('omit_kicker',False):
    self.p(page.get('kicker','QA 및 사용성 평가'),'label',pagebreak=has_previous,spacing_after_pt=4)
    self.p(page['title'],'title',spacing_after_pt=8)
   else:self.p(page['title'],'title',pagebreak=has_previous,spacing_after_pt=8)
   if page.get('lead'):self.p(page['lead'])
   for b in page.get('blocks',[]):
    typ=b.get('type','bullets')
    if typ=='heading':self.p(b['text'],'h2',spacing_before_pt=8,spacing_after_pt=5,keep_with_next=True)
    elif typ=='paragraph':self.p(b['text'],b.get('style','body'))
    elif typ=='link':
     p=self.p('',b.get('style','small'));self.doc.add_hyperlink(b['url'],b['text'],paragraph=p,char_pr_id_ref=self.styles[b.get('style','small')])
    elif typ=='bullets':
     for s in b['items']:self.p('• '+s,b.get('style','body'))
    elif typ=='table':self.table(b)
    elif typ=='image':self.image(b)
    elif typ=='flow_step':self.flow_step(b)
    elif typ=='space':self.p('',spacing_after_pt=float(b.get('pt',8)))
    else:raise ValueError(typ)
  return self.doc

def main():
 src=Path(sys.argv[1]).resolve();dest=Path(sys.argv[2]).resolve();data=json.loads(src.read_text())
 for page in data.get('pages',[]):
  for block in page.get('blocks',[]):
   if block.get('type') in ('flow_step','image'):
    path=Path(block['path'])
    if not path.is_absolute():block['path']=str(src.parent/path)
 dest.parent.mkdir(parents=True,exist_ok=True)
 r=Report(data);doc=r.render();check=doc.validate();
 if check.issues:raise ValueError(check)
 doc.package.set_part('Preview/PrvText.txt',doc.export_text().encode('utf-8'))
 # A cover thumbnail will be added only after native Hancom PDF export and inspection.
 if doc.package.has_part('Preview/PrvImage.png'):doc.package.delete('Preview/PrvImage.png')
 doc.save_to_path(dest)
 with zipfile.ZipFile(dest) as z:
  assert z.testzip() is None
  assert z.read('mimetype')==b'application/hwp+zip'
 reopened=HwpxDocument.open(dest)
 extracted=reopened.export_text()
 dest.with_suffix('.txt').write_text(extracted)
 estimate=estimate_pages(dest)
 audit={**r.counts,'annotation_warnings':r.annotation_warnings,'estimated_pages':estimate.pages,'layout_estimate_limitations':list(estimate.unsupported),'schema_issues':0,'zip_integrity':True,'text_characters':len(extracted),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'output':str(dest.resolve())}
 dest.with_suffix('.validation.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2));print(json.dumps(audit,ensure_ascii=False))
if __name__=='__main__':main()
