const test=require('node:test');
const assert=require('node:assert/strict');
const parser=import('../src/markdown-inline.mjs');

test('agent file links preserve spaces, parentheses, Unicode and line references',async()=>{
 const {parseInlineMarkdown}=await parser;
 const result=parseInlineMarkdown('파일: [결과 보기](reports/실행 결과 (최종).md:12) 및 [다음](<docs/화면 (모바일).html#L8>)');
 assert.deepEqual(result.filter(item=>item.type==='link'),[
  {type:'link',label:'결과 보기',target:'reports/실행 결과 (최종).md:12'},
  {type:'link',label:'다음',target:'docs/화면 (모바일).html#L8'}
 ]);
});

test('agent links keep literal percentages and encoded paths for backend resolution',async()=>{
 const {parseInlineMarkdown}=await parser;
 const links=parseInlineMarkdown('[완료](build/100% 완료.txt) [URL](file:///opt/project/report%20final.md#L22) [출력](sandbox:/mnt/data/report.pdf)').filter(item=>item.type==='link');
 assert.deepEqual(links.map(item=>item.target),['build/100% 완료.txt','file:///opt/project/report%20final.md#L22','sandbox:/mnt/data/report.pdf']);
});

test('inline code and escaped Markdown never become file links',async()=>{
 const {parseInlineMarkdown}=await parser;
 assert.deepEqual(parseInlineMarkdown('`[설명](private.txt)` \\[설명](other.txt)'),[
  {type:'code',text:'[설명](private.txt)'},
  {type:'text',text:' [설명](other.txt)'}
 ]);
});

test('escaped link delimiters and optional titles do not change the file destination',async()=>{
 const {parseInlineMarkdown}=await parser;
 assert.deepEqual(parseInlineMarkdown('[report [v2]](reports/final\\(1\\).md "결과 파일") [HTML](<report (2).html> "미리보기")').filter(item=>item.type==='link'),[
  {type:'link',label:'report [v2]',target:'reports/final(1).md'},
  {type:'link',label:'HTML',target:'report (2).html'}
 ]);
});

test('invalid links stay text and ordinary formatting is preserved',async()=>{
 const {parseInlineMarkdown}=await parser;
 assert.deepEqual(parseInlineMarkdown('**굵게** *강조* [깨진 링크](missing (file)'),[
  {type:'strong',text:'굵게'},
  {type:'text',text:' '},
  {type:'em',text:'강조'},
  {type:'text',text:' [깨진 링크](missing (file)'}
 ]);
});

test('only HTTP and HTTPS open externally; executable URL schemes cannot open',async()=>{
 const {markdownLinkType}=await parser;
 for(const target of ['https://example.test/report?q=1','HTTP://example.test'])assert.equal(markdownLinkType(target),'external');
 for(const target of ['docs/result.md','report.md:12','report.md:12:3','Dockerfile:12','Makefile:12:3','/opt/spring/docs/development-log.md:8305','/opt/reviewops/result.html','file:///opt/result.pdf','file:/opt/spring/report.md:12','sandbox:/mnt/data/result.png'])assert.equal(markdownLinkType(target),'file');
 for(const target of ['javascript:alert(1)','javascript:12','data:text/html,<script>','vbscript:msgbox(1)','mailto:user@example.test','mailto:123','tel:123','http:12','https:12'])assert.equal(markdownLinkType(target),null);
});
