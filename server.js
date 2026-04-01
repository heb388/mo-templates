const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json({ limit: '5mb' }));

app.post('/render-pdf', async (req, res) => {
  const { html, width = '770px', height = 'auto' } = req.body;

  if (!html) {
    return res.status(400).json({ error: 'No HTML provided' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: 'new'
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      printBackground: true,
      width: width,
      height: height === 'auto' ? undefined : height,
      pageRanges: '1'
    });

    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="newsletter.pdf"'
    });
    res.send(pdf);

  } catch (err) {
    if (browser) await browser.close();
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Renderer running on port ${PORT}`));
