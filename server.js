const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');

const app = express();
const OUTPUT_DIR = path.join(__dirname, 'output');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR);
}

app.use(express.json({ limit: '5mb' }));
app.use('/output', express.static(OUTPUT_DIR));

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = 'Drops Workable';
const RENDER_BASE_URL = 'https://mo-templates.onrender.com';
const TEMPLATE_URL = 'https://heb388.github.io/mo-templates/template-drop.html';

async function airtableRequest(apiPath, options = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable API failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function getRecord(recordId) {
  return airtableRequest(`${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`);
}

async function updateRecord(recordId, fields) {
  return airtableRequest(`${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields })
  });
}

function replaceTokens(html, replacements) {
  for (const [token, value] of Object.entries(replacements)) {
    html = html.replaceAll(token, value ?? '');
  }
  return html;
}

function requiredField(value) {
  return typeof value === 'string' ? value.trim() : value;
}

async function renderPdfFromHtml(html, width = '770px') {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: parseInt(width, 10), height: 5000 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.emulateMediaType('screen');

    const pdf = await page.pdf({
      printBackground: true,
      width,
      pageRanges: '1'
    });

    return pdf;
  } finally {
    await browser.close();
  }
}

async function runJob(recordId) {
  try {
    await updateRecord(recordId, {
      'Template Status': 'Writing',
      'Render Debug': 'Fetching Airtable record'
    });

    const record = await getRecord(recordId);
    const f = record.fields || {};

    // Light validation for fields the template actually needs
    const missing = [];
    if (!requiredField(f['Newsletter Title'])) missing.push('Newsletter Title');
    if (!requiredField(f['Newsletter Description'])) missing.push('Newsletter Description');
    if (!requiredField(f['Hero Image URL'])) missing.push('Hero Image URL');

    if (missing.length) {
      throw new Error(`Missing required template fields: ${missing.join(', ')}`);
    }

    await updateRecord(recordId, {
      'Template Status': 'Rendering',
      'Render Debug': 'Fetching template'
    });

    const templateRes = await fetch(TEMPLATE_URL);
    if (!templateRes.ok) {
      throw new Error(`Template fetch failed: ${templateRes.status}`);
    }

    let html = await templateRes.text();

    html = replaceTokens(html, {
      '{{NEWSLETTER_ISSUE}}': f['Newsletter Issue Label'] || 'The Drop',
      '{{NEWSLETTER_TITLE}}': f['Newsletter Title'] || '',
      '{{NEWSLETTER_DESCRIPTION}}': f['Newsletter Description'] || '',
      '{{HERO_IMAGE_URL}}': f['Hero Image URL'] || '',
      '{{HERO_TITLE_RIGHT}}': f['Hero Title Right'] || f['Drop Name'] || '',
      '{{SECTION_HEADER}}': "This Week's Drop",

      '{{P1_NAME}}': f['P1 Name'] || '',
      '{{P1_DESIGNER}}': f['P1 Designer'] || '',
      '{{P1_LABEL}}': f['P1 Condition'] || '',
      '{{P1_PRICE}}': f['P1 Price'] || '',
      '{{P1_RETAIL}}': f['P1 Retail'] || '',
      '{{P1_URL}}': f['P1 URL'] || '#',
      '{{P1_IMAGE}}': f['P1 Image URL'] || '',

      '{{P2_NAME}}': f['P2 Name'] || '',
      '{{P2_DESIGNER}}': f['P2 Designer'] || '',
      '{{P2_LABEL}}': f['P2 Condition'] || '',
      '{{P2_PRICE}}': f['P2 Price'] || '',
      '{{P2_RETAIL}}': f['P2 Retail'] || '',
      '{{P2_URL}}': f['P2 URL'] || '#',
      '{{P2_IMAGE}}': f['P2 Image URL'] || '',

      '{{P3_NAME}}': f['P3 Name'] || '',
      '{{P3_DESIGNER}}': f['P3 Designer'] || '',
      '{{P3_LABEL}}': f['P3 Condition'] || '',
      '{{P3_PRICE}}': f['P3 Price'] || '',
      '{{P3_RETAIL}}': f['P3 Retail'] || '',
      '{{P3_URL}}': f['P3 URL'] || '#',
      '{{P3_IMAGE}}': f['P3 Image URL'] || '',

      '{{P4_NAME}}': f['P4 Name'] || '',
      '{{P4_DESIGNER}}': f['P4 Designer'] || '',
      '{{P4_LABEL}}': f['P4 Condition'] || '',
      '{{P4_PRICE}}': f['P4 Price'] || '',
      '{{P4_RETAIL}}': f['P4 Retail'] || '',
      '{{P4_URL}}': f['P4 URL'] || '#',
      '{{P4_IMAGE}}': f['P4 Image URL'] || ''
    });

    await updateRecord(recordId, {
      'Render Debug': 'Generating PDF'
    });

    const pdfBuffer = await renderPdfFromHtml(html, '770px');

    const fileName = `${recordId}.pdf`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(filePath, pdfBuffer);

    const publicUrl = `${RENDER_BASE_URL}/output/${fileName}`;

    await updateRecord(recordId, {
      'Rendered PDF': [{ url: publicUrl, filename: fileName }],
      'Template Status': 'Done',
      'Render Debug': 'PDF generated successfully'
    });

  } catch (err) {
    console.error(err);
    try {
      await updateRecord(recordId, {
        'Template Status': 'Error',
        'Render Debug': err.message
      });
    } catch (innerErr) {
      console.error('Failed to write error back to Airtable:', innerErr);
    }
  }
}

app.post('/start-job', async (req, res) => {
  const { recordId } = req.body;

  if (!recordId) {
    return res.status(400).json({ error: 'Missing recordId' });
  }

  res.json({ ok: true });

  runJob(recordId).catch(err => {
    console.error('Background job failed:', err);
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Renderer running on port ${PORT}`);
});
