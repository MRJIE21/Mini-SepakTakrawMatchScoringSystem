/* Exercise retained enrollment/seed components without adding a second product page. */
export async function installLegacyRosterFixture(page) {
  await page.addInitScript(async () => {
    if (!location.hash.startsWith('#/legacyRosterTest')) return;
    const { registerView } = await import('/js/main.js');
    registerView({ name: 'legacyRosterTest', label: '历史名单组件测试', render: async ({ el, params }) => {
      const { api } = await import('/js/api.js');
      const { rosterView } = await import('/js/views/catalog.js');
      const load = async () => {
        const data = await api.get(`/api/categories/${Number(params.category)}/participations`);
        el.replaceChildren(rosterView(data.category, data.participations, load));
      };
      await load();
    } });
  });
}
