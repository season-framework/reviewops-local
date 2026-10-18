export function deletionTargets(data, entity, id) {
 const groupIds = new Set(entity === 'group' ? [id] : []);
 const projectIds = new Set(data.projects.filter(project => entity === 'project' ? project.id === id : groupIds.has(project.groupId)).map(project => project.id));
 const serviceIds = new Set(data.services.filter(service => entity === 'service' ? service.id === id : groupIds.has(service.groupId)).map(service => service.id));
 const reviewIds = new Set(data.reviews.filter(review => entity === 'review' ? review.id === id : projectIds.has(review.projectId)).map(review => review.id));
 return {groupIds, projectIds, serviceIds, reviewIds};
}

export function deletedTab(tab, targets) {
 const ids = {group:targets.groupIds, project:targets.projectIds, service:targets.serviceIds, review:targets.reviewIds};
 if (ids[tab.kind]?.has(tab.entityId)) return true;
 if (tab.kind !== 'editor') return false;
 return Boolean(ids[tab.entityType]?.has(tab.record?.id) || targets.groupIds.has(tab.record?.groupId) || targets.projectIds.has(tab.record?.projectId));
}

export function clearDeletionDrafts(storage, targets) {
 const tokens = new Set();
 for (const id of targets.reviewIds) {
  const agentKey = `reviewops.agent.draft.${id}`;
  try {
   const draft = JSON.parse(storage.getItem(agentKey) || '{}');
   for (const file of Array.isArray(draft.pending) ? draft.pending : []) if (file?.token) tokens.add(file.token);
  } catch {}
  for (const key of [agentKey, `reviewops.review.edit.${id}`, `reviewops.draft.${id}`, `reviewops.comment.${id}`]) storage.removeItem(key);
 }
 for (const id of targets.projectIds) {
  for (const key of [`reviewops.review.create.${id}`, `reviewops.draft.create-${id}`, `reviewops.comment.create-${id}`]) storage.removeItem(key);
 }
 if (targets.reviewIds.has(storage.getItem('reviewops.home.selected'))) storage.removeItem('reviewops.home.selected');
 try {
  const favorites = JSON.parse(storage.getItem('reviewops.home.favorites') || '[]');
  if (Array.isArray(favorites)) storage.setItem('reviewops.home.favorites', JSON.stringify(favorites.filter(id => !targets.projectIds.has(id))));
 } catch {}
 return [...tokens];
}
