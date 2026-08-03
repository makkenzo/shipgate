import { expect, test } from '@playwright/test'

test('serves the production connection UI and operational endpoints', async ({ page, request }) => {
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

  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Connect Shipgate to GitHub' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible()
})
