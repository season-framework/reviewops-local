#!/usr/bin/env python3
"""Read-only checks of HWPX content, source image bytes, MIME, and annotations."""
from pathlib import Path
from collections import Counter
from io import BytesIO
import sys,json,zipfile,hashlib,re,dataclasses
from lxml import etree
from PIL import Image
from hwpx import HwpxDocument
from hwpx.tools.package_validator import validate_package

p=Path(sys.argv[1]).resolve();source=Path(sys.argv[2]).resolve();data=json.loads(source.read_text())
ns={'hp':'http://www.hancom.co.kr/hwpml/2011/paragraph'}
digest=lambda b:hashlib.sha256(b).hexdigest()
compact=lambda s:''.join(str(s).split())
blocks=[b for pg in data['pages'] for b in pg['blocks']]
flows=[b for b in blocks if b['type']=='flow_step']
assert not any(b['type']=='image' for b in blocks),'Use flow_step for uncropped whole-window evidence.'
source_images=[(source.parent/Path(b['path'])).resolve() for b in flows]
expected_annotations=sum(len(b.get('annotations',[])) for b in flows)
labels={'통과':'pass','오류 발견':'error_found','기능 미제공':'not_provided','미실행':'not_run','부분 확인':'partial'}
qa=[]
for b in blocks:
 if b['type']=='table':
  for row in b.get('rows',[]):
   match=re.match(r'(QA-[A-Za-z0-9_-]+)',row[0])
   if match:
    status=next((v for k,v in labels.items() if row[-1].startswith(k)),None)
    if status is None and '미제공' in row[-1]:status='not_provided'
    qa.append({'id':match.group(1),'status':status or 'unknown'})
required=[]
cover=data.get('cover',{})
if not data.get('omit_cover',False):
 required+=cover.get('title',[])+cover.get('notes',[])
 required+=[cover[k] for k in ('kicker','subtitle') if k in cover]
 required += [str(s) for row in cover.get('rows',[]) for s in row]
for pg in data['pages']:
 required.append(pg['title'])
 if pg.get('lead'):required.append(pg['lead'])
 for b in pg['blocks']:
  if b['type']=='table':required+=list(b.get('headers',[]))+[str(s) for row in b.get('rows',[]) for s in row]
  elif b['type']=='bullets':required+=b['items']
  elif b['type']=='flow_step':required += [b['title'],b['caption']]
  elif b.get('text'):required.append(b['text'])
with zipfile.ZipFile(p) as z:
 xmls={n:etree.fromstring(z.read(n)) for n in z.namelist() if n.endswith('.xml')}
 sections=[x for n,x in xmls.items() if n.startswith('Contents/section')]
 tables=sum(len(s.findall('.//hp:tbl',ns)) for s in sections)
 pictures=sum(len(s.findall('.//hp:pic',ns)) for s in sections)
 groups=sum(len(s.findall('.//hp:container',ns)) for s in sections)
 textboxes=sum(len(s.findall('.//hp:drawText',ns)) for s in sections)
 images=[n for n in z.namelist() if n.startswith('BinData/')]
 same=Counter(digest(z.read(n)) for n in images)==Counter(digest(f.read_bytes()) for f in source_images)
 manifest=etree.fromstring(z.read('Contents/content.hpf'))
 mime_by_path={e.get('href'):e.get('media-type') for e in manifest.iter() if e.get('href') is not None}
 mime_checks=[]
 for name in images:
  im=Image.open(BytesIO(z.read(name)));actual='image/'+im.format.lower().replace('jpg','jpeg')
  mime_checks.append({'part':name,'actual':actual,'declared':mime_by_path.get(name),'match':actual==mime_by_path.get(name)})
 colors=[];nongray=[]
 for name,root in xmls.items():
  for e in root.iter():
   for k,v in e.attrib.items():
    if 'color' in k.lower():
     colors.append(v);rgb=v.lstrip('#')[-6:].lower()
     if re.fullmatch('[0-9a-f]{6}',rgb) and not rgb[:2]==rgb[2:4]==rgb[4:]:nongray.append({'part':name,'value':v})
 text='\n'.join(''.join(t.itertext()) for s in sections for t in s.findall('.//hp:t',ns))
 missing_text=[t for t in required if compact(t) and compact(t) not in compact(text)]
 # These are review flags, not a language model or a ban on literal UI quotations.
 flagged_terms=data.get('review_terms',['근거','기준','참고자료','현재 확인','다음 작업','추가 필요','개선 예정','권고','남은 작업'])
 hits=[s for s in flagged_terms if s in text]
 caption_checks=[]
 for i,b in enumerate(flows,1):
  expected_numbers=sorted({a['number'] for a in b.get('annotations',[])})
  actual_numbers=[n for n in range(1,21) if chr(0x245f+n) in b['caption']]
  caption_checks.append({'image':i,'step':b['title'],'expected':expected_numbers,'actual':actual_numbers})
 caption_mismatches=[c for c in caption_checks if c['expected']!=c['actual']]
 caption_match=not caption_mismatches
 qa_counts=dict(Counter(q['status'] for q in qa));qa_ids=[q['id'] for q in qa]
 expected={q['id']:q['status'] for q in data.get('qa_scenarios',[])}
 audit={'file':str(p),'source':str(source),'planned_pages':len(data['pages'])+(0 if data.get('omit_cover',False) else 1),
  'tables':tables,'pictures':pictures,'embedded_images':len(images),'editable_image_groups':groups,'annotation_numbers':textboxes,
  'source_image_bytes_unchanged':same,'image_mime_matches':all(x['match'] for x in mime_checks),'image_mime_details':mime_checks,
  'missing_source_text':missing_text,'all_xml_colors':sorted(set(colors)),'nongray_colors':nongray,'preview_image_present':'Preview/PrvImage.png' in z.namelist(),
  'zip_integrity':z.testzip() is None,'schema_issues':len(HwpxDocument.open(p).validate().issues),
  'package_validation':dataclasses.asdict(validate_package(p)),'qa_counts':qa_counts,'qa_unique_ids':len(set(qa_ids)),
  'language_review_flags':hits,'annotation_caption_numbers_match':caption_match,
  'sha256':digest(p.read_bytes()),'source_sha256':digest(source.read_bytes()),'native_visual_review':'Manual native PDF review is required; this script does not modify the document.'}
 assert tables==(0 if data.get('omit_cover',False) else 1)+sum(b['type']=='table' for b in blocks)
 assert pictures==groups==len(source_images)==len(images) and same and not nongray
 assert textboxes==expected_annotations,f'번호 도형 개수 불일치: expected={expected_annotations}, actual={textboxes}'
 if caption_mismatches:
  c=caption_mismatches[0]
  raise SystemExit(f"사진 {c['image']} 캡션 번호 불일치 ({c['step']}): expected={c['expected']}, actual={c['actual']}")
 assert len(qa_ids)==len(set(qa_ids)),'Duplicate QA IDs in result rows.'
 if expected:assert {q['id']:q['status'] for q in qa}==expected,'Scenario IDs or status labels differ from qa_scenarios.'
 if data.get('expected_counts') and qa_counts!=data['expected_counts']:
  raise SystemExit(f"QA 집계 불일치: expected={data['expected_counts']}, actual={qa_counts}")
 assert not missing_text and audit['image_mime_matches']
 assert not audit['schema_issues'] and audit['zip_integrity']
 assert not any(i['level']=='error' for i in audit['package_validation']['issues'])
 p.with_suffix('.audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2,default=str)+'\n')
 print(json.dumps({k:v for k,v in audit.items() if k not in ['image_mime_details','package_validation']},ensure_ascii=False,indent=2))
