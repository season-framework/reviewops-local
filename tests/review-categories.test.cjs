const test=require('node:test');
const assert=require('node:assert/strict');
const helpers=()=>import('../src/review-categories.js');
const custom={id:'custom_12345678-1234-1234-1234-123456789abc',name:'Release <check>'};

test('fresh review category choices contain exactly the seven defaults and include old values only when present',async()=>{
  const {reviewCategoryOptions}=await helpers();
  assert.deepEqual(reviewCategoryOptions({},'',value=>value),[['bug','버그'],['ux','UX'],['content','콘텐츠'],['performance','성능'],['accessibility','접근성'],['security','보안'],['other','기타']]);
  const data={reviews:[{category:'feature'},{category:'design'}],settings:{reviewCategories:[custom]}};
  assert.deepEqual(reviewCategoryOptions(data,'structure',value=>value).map(([id])=>id),['bug','ux','content','performance','accessibility','security','other','feature','structure','design',custom.id]);
});

test('custom category names are displayed verbatim and searched with title and localized built-in labels',async()=>{
  const {reviewCategoryLabel,matchesReviewSearch}=await helpers(),data={settings:{reviewCategories:[custom]}};
  const translate=value=>({'버그':'Bug','기능':'Feature'}[value]||'translated '+value);
  assert.equal(reviewCategoryLabel(custom.id,data,translate),custom.name);
  assert.equal(reviewCategoryLabel('feature',data,translate),'Feature');
  assert(matchesReviewSearch({title:'Keep request',category:custom.id},'Ｒｅｌｅａｓｅ',data,translate));
  assert(matchesReviewSearch({title:'Keep request',category:'bug'},'bug',data,translate));
  assert(matchesReviewSearch({title:'Keep request',category:custom.id},'keep',data,translate));
  assert(!matchesReviewSearch({title:'Keep request',category:custom.id},custom.id,data,translate));
  assert(!matchesReviewSearch({title:'Keep request',category:custom.id},'missing',data,translate));
});
