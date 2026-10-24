/* The former separate people/project tabs now share one editor. Existing
   regression vectors still edit the same fields through real UI navigation. */
const catalogNames = new WeakMap();

export async function registrationEdit(page) {
  await page.getByRole('tab', {name:'统一编辑',exact:true}).click();
  const collapsed=page.locator('.school-registration-people .school-registration-person:not([open]) > summary');
  while(await collapsed.count()) await collapsed.first().click();
}

export async function registrationProject(page,id) {
  const card=page.locator(`.school-registration-project[data-category="${id}"]`);
  if(await card.isVisible())return card;
  if(!catalogNames.has(page))catalogNames.set(page,await page.evaluate(async()=>{
    const {api,getApiEventContext}=await import('/js/api.js');
    const identity=getApiEventContext();
    const structure=await api.get(`/api/events/${identity.event_id}/structure`);
    return Object.fromEntries(structure.groups.flatMap(g=>g.categories).map(c=>[c.id,c.name]));
  }));
  const name=catalogNames.get(page)[id];
  if(!name)throw new Error(`Missing registration project ${id}`);
  await page.getByRole('tab',{name:'统一编辑',exact:true}).click();
  const catalog=page.locator('.school-registration-catalog');
  await catalog.getByRole('button').filter({hasText:name+' · '}).click();
  await card.waitFor();return card;
}
