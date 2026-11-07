#!/usr/bin/env python3
"""Inspect native Hancom PDF: text per page, planned title placement and page previews."""
from pathlib import Path
import json,sys,subprocess, math,re
from pypdf import PdfReader
from PIL import Image, ImageDraw
pdf=Path(sys.argv[1]);content=Path(sys.argv[2]) if len(sys.argv)>2 else None
out=pdf.parent/(pdf.stem+'-pages');out.mkdir(exist_ok=True)
# This directory is reserved for generated previews; discard stale pages from a longer prior export.
for generated in out.iterdir():
 if generated.is_file() and re.fullmatch(r'(?:page-\d+\.(?:png|txt)|contact-\d+\.png|inspection\.json)',generated.name):generated.unlink()
reader=PdfReader(pdf)
pages=[]
for i,p in enumerate(reader.pages,1):
 text=p.extract_text()
 (out/f'page-{i:02}.txt').write_text(text)
 pages.append({'page':i,'width_pt':float(p.mediabox.width),'height_pt':float(p.mediabox.height),'text_chars':len(text),'text':text})
expected=[]
if content:
 data=json.loads(content.read_text())
 first_page=1 if data.get('omit_cover',False) else 2
 for i,p in enumerate(data['pages'],first_page):
  title=p['title'];match=[x['page'] for x in pages if ''.join(title.split()) in ''.join(x['text'].split())]
  expected.append({'title':title,'planned_page':i,'found_pages':match,'exact_page_match':i in match})
subprocess.run(['pdftoppm','-png','-scale-to','1600',str(pdf),str(out/'page')],check=True)
images=sorted(out.glob('page-*.png'),key=lambda p:int(p.stem.split('-')[-1]))
for start in range(0,len(images),9):
 sheet=Image.new('RGB',(900,1370),'#dce2e6');draw=ImageDraw.Draw(sheet)
 for j,path in enumerate(images[start:start+9]):
  im=Image.open(path).convert('RGB');im.thumbnail((280,410))
  x=(j%3)*300+10;y=(j//3)*455+25
  sheet.paste(im,(x,y));draw.text((x,y-17),f'Page {start+j+1}',fill='#000000')
 sheet.save(out/f'contact-{start//9+1:02}.png')
report={'pdf_sha256':__import__('hashlib').sha256(pdf.read_bytes()).hexdigest(),'native_pdf_pages':len(pages),'expected_pages':len(expected)+(0 if data.get('omit_cover',False) else 1) if content else None,'title_placement':expected,'page_text_counts':[{'page':p['page'],'text_chars':p['text_chars']} for p in pages],'visual_review_directory':str(out.resolve())}
(out/'inspection.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2))
