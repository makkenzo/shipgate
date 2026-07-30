import { expect, test } from '@playwright/test'

test('serves the production SPA and reports system readiness', async ({ page, request }) => {
  await expect
    .poll(
      async () => {
        const response = await request.get('/ready')

        return response.status()
      },
      {
        timeout: 60_000,
      },
    )
    .toBe(200)

  await page.goto('/')

  await expect(
    page.getByRole('heading', {
      name: 'System status',
    }),
  ).toBeVisible()

  await expect(page.getByText('All systems operational')).toBeVisible({
    timeout: 30_000,
  })

  await expect(page.getByText('API status')).toBeVisible()

  await expect(page.getByText('Worker status')).toBeVisible()

  await expect(page.getByText('Database status')).toBeVisible()
})
