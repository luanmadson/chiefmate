// Made-up files for the tests (npm test, npm run smoke): a zip writer, a small XLSX workbook, a CSV and a PNG.
import zlib from 'node:zlib';

/** A zip file of { name: text or Buffer }, each part deflated. */
export function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const fileName = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, fileName, packed);
    central.push(entry, fileName);
    offset += local.length + fileName.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/**
 * A workbook with two sheets. "Sales": a header, shared and inline strings, a number, a date (format 14), a boolean and
 * a skipped column. "Notes & more": tags with a namespace prefix, as some programs write them. extraRows adds numbered
 * rows to the first sheet.
 */
export function sampleXlsx({ extraRows = 0 } = {}) {
  const more = Array.from({ length: extraRows }, (_, i) => `<row r="${i + 5}"><c r="A${i + 5}" t="inlineStr"><is><t>Row ${i + 5}</t></is></c><c r="B${i + 5}"><v>${i}</v></c></row>`).join('');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${ns}><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${ns} count="3" uniqueCount="3"><si><t>Product</t></si><si><r><t>Unit </t></r><r><rPr><b/></rPr><t>price</t></r><rPh><t>x</t></rPh></si><si><t>Tea &amp; biscuits_x000D_</t></si></sst>`,
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${ns}><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${ns}><sheetData>`
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Date</t></is></c><c r="E1" t="inlineStr"><is><t>Paid</t></is></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><v>12.5</v></c><c r="C2" s="1"><v>46082</v></c><c r="E2" t="b"><v>1</v></c></row>'
      + `<row r="4"><c r="A4" t="str"><f>A2</f><v>formula &lt;text&gt;</v></c></row>${more}`
      + '<row r="900" s="1"/></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Only note</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>',
  });
}

export const SAMPLE_CSV = 'name;city;note\r\nAna;"Porto Alegre";"said ""hi""\nand left"\r\nBeto;Recife;\r\n';

// A 1x1 PNG.
export const SAMPLE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
