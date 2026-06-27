import pw from 'file:///D:/Projects/x-reader/node_modules/playwright-core/index.js'
const { chromium } = pw
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1180, height: 1400 }, deviceScaleFactor: 2 })
await page.goto('file:///D:/Projects/clip-factory/docs/pipeline.html', { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForSelector('.mermaid svg', { timeout: 30000 })
await page.waitForTimeout(1000)
await page.screenshot({ path: 'D:/Projects/clip-factory/docs/pipeline.png', fullPage: true })
await browser.close()
console.log('saved docs/pipeline.png')
