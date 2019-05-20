const Url = require('url');
const HTTPS = require("https");
const HTTP = require("http");
const XMLWriter = require('xml-writer');
const Winston = require('winston');
const Moment = require('moment');

let WinstonTransportFile;
let Log = Winston.createLogger({
  level: 'info',
  // format: winston.format.json(),
  // defaultMeta: { service: 'user-service' },
  transports: []
});

function setLogLevel(level) {
  if ( ! WinstonTransportFile ) {
    WinstonTransportFile = new Winston.transports.File({ filename: Config.Log , level: 'info', format: Winston.format.simple() })
    Log.add(WinstonTransportFile)
  }
  WinstonTransportFile.level = level || Config.LogLevel || 'info';
}

function cleanUpString( str ) {
  return str ? str.replace( /^"|"$/g, '' ) : str;
}


function request(url, headers, callback, streaming) {

  const urlObj = Url.parse( url );

  const opts = Object.assign(urlObj, {headers: headers});

  const protocol = opts.protocol.toLowerCase();

  if ( ['http:', 'https:'].indexOf(protocol) <= -1 ) {
    callback( 'protocol not supported', url);
    return;
  }

  const MODULE = protocol.indexOf('https') === 0 ? HTTPS : HTTP;

  MODULE.get(opts, (res) => {
    if ( res.statusCode >= 200 && res.statusCode < 300 ) {

      if ( streaming ) {
        return callback(null, res);
      }

      const bufs = [];

      res.on('data', (chunk) => {
        bufs.push(chunk);
      });

      res.on('end', () => {
        const buf = Buffer.concat(bufs);
        const string = buf.toString('utf8');

        Log.debug(`Finish getting data from ${url} ${string.length} bytes`);

        callback( null, string );
      })
    } else if ( res.statusCode >= 400 ) {
      callback( true, null );
    }
  });
}


function _URL_(str, base) {
  return new URL(str, base);
}

function urlShouldBeComputed(url, base) {
  if ( typeof url === 'string' ) {
    url = _URL_(url, base);
  }

  const pathname = url.pathname;
  const ext = pathname.split('.').pop();

  return ['htm', 'html', 'm3u', 'm3u8'].indexOf( ext.toLowerCase() ) > -1;
}


function responseToString(res) {
  return new Promise( (resolve, reject) => {
    const buff = [];
    // res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buff.push(chunk);
    });
    res.on('end', () => {
      const b = Buffer.concat(buff);
      const string = b.toString('utf8');
      resolve(string);
    });
  });
}

function calculateNewUrlToCompute(url, base) {

  let nurl = null;
  try {
    nurl = new URL(url, base);
  } catch(e) {
    Log.error(`Cannot resolve url '${url}' based on '${base}'`);
    throw e;
  }

  return computeChannelStreamUrl({StreamUrl: nurl.href});
}


function computeChannelStreamUrl(channel) {

  const chl_url = channel.StreamUrl;

  const sc = urlShouldBeComputed( chl_url );

  const urlObj = Url.parse( chl_url );
  const protocol = urlObj.protocol.toLowerCase();

  Log.debug(`Compute channel stream url for protocol: ${protocol}`);
  return new Promise( (resolve, reject) => {

    if ( !sc ) {
      Log.debug('url doesn\'t need to be computed');
      return resolve( chl_url );
    }

    if ( ['http:', 'https:'].indexOf(protocol) <= -1 ) {
      Log.warn(`stream protocol cannot be computed. Use the original one: ${urlObj.protocol.toLowerCase()}`)
      resolve(chl_url);
      return;
    }

    const MODULE = protocol.indexOf('https') === 0 ? HTTPS : HTTP;
    const chl_url_obj = Url.parse(chl_url);

    const opts = Object.assign(chl_url_obj, {
      method: 'GET',
      headers: {
        "user-agent": "VLC"
      }
    });

    const Req = MODULE.request(opts, (res) => {

      const contentType = res.headers['content-type'];
      const location = res.headers['location'];

      if ( res.statusCode >= 200 && res.statusCode < 300 ) {
        // we have a direct response
        if ( contentType.indexOf('mpegURL') > -1 ) {

          responseToString(res).then( (data) => {
            let schl = null;
            try {
              schl = parseM3U( data );
            } catch(e) {
              Log.error(`Cannot parse m3u while computing due to: ${e}`);
              return resolve( chl_url );
            }

            let cnutc = null;
            try {
              cnutc = calculateNewUrlToCompute(schl.StreamUrl, chl_url);
            } catch(e) {
              return resolve(chl_url);
            }
            cnutc.then( (new_url) => {
              resolve( new_url );
            });

          });
        }

      } else if ( res.statusCode >= 300 && res.statusCode < 400 ) {

        let cnutc = null;
        try {
          cnutc = calculateNewUrlToCompute(location, chl_url);
        } catch(e) {
          return resolve(chl_url);
        }
        cnutc.then( (new_url) => {
          resolve( new_url );
        });

      } else {
        Log.error(`Error while computing stream-url: Status ${res.statusCode}`);
        resolve( chl_url );
      }
    });

    Req.on('error', (e) => {
      Log.error(`An error occurred while computing channel stream-url: ${e}`);
      resolve( chl_url );
    });

    Req.end();
  });

}


function parseM3U(str) {
  const M3UK = require('./modules/m3u').M3U;

  const M3U = new M3UK();
  M3U.load(str);

  return M3U.groups[0].channels[0];
}

function createXMLTV(EPG, SHIFT) {

  if ( ! Array.isArray(SHIFT) ) {
    SHIFT = [SHIFT];
  }

  if ( SHIFT[0] !== 0 ) {
    SHIFT.unshift( 0 );
  }

  Log.info('creating XMLTV');
  Log.debug(`Shift hours ${SHIFT.join(', ')}`)

  const XW = new XMLWriter();
  XW.startDocument('1.0', 'UTF-8');
  const TV = XW.startElement('tv');
  TV.writeAttribute('source-info-name', 'EPG');
  TV.writeAttribute('generator-info-name', 'simple tv grab it');
  TV.writeAttribute('generator-info-url', '');
  for( let CHL of EPG ) {
    for ( let shift of SHIFT ) {
      const chl_id = shift ? `${CHL.IdEpg}-${shift}` : CHL.IdEpg;

      const chl_name = shift ? `${CHL.Name} +${shift}` : CHL.Name;
      const chl_el = TV.startElement('channel');
      chl_el.writeAttribute('id', chl_id);
      chl_el.writeAttribute('name', chl_name);
      if ( ! shift ) {
        chl_el.writeAttribute('number', CHL.Number);
      }

      chl_el.startElement('display-name')
        .writeAttribute('lang', 'it')
        .text(chl_name)
        .endElement();

      if ( !shift ) {
        chl_el.startElement('display-name')
          .writeAttribute('lang', 'it')
          .text(CHL.Number)
          .endElement();
      }

      chl_el.startElement('icon').writeAttribute('src', CHL.Logo).endElement();
      if ( CHL.Url ) {
        chl_el.startElement('url').text( CHL.Url ).endElement();
      }
      chl_el.endElement();
    }
  }


  for( let CHL of EPG ) {

    for( let shift of SHIFT ) {
      const chl_id = shift ? `${CHL.IdEpg}-${shift}` : CHL.IdEpg;

      const dates = Object.keys( CHL.Epg );

      for ( let datetime_str of dates ) {
        const programs = CHL.Epg[ datetime_str ];

        for ( let PRG of programs ) {

          const prg_el = TV.startElement('programme');

          let starttime = new Date(PRG.Start);
          starttime.setMinutes( starttime.getMinutes() + (60 * shift) );
          prg_el.writeAttribute('start', Moment(starttime).format('YYYYMMDDHHmmss Z').replace(':', '') );

          let endtime = new Date(PRG.Stop);
          endtime.setMinutes( endtime.getMinutes() + (60 * shift) );
          prg_el.writeAttribute('stop', Moment(endtime).format('YYYYMMDDHHmmss Z').replace(':', '') );

          prg_el.writeAttribute('channel', chl_id);

          const id_el = prg_el.startElement('id')
                  .text(PRG.Id)
                  .endElement();
          const pid_el = prg_el.startElement('pid')
                  .text(PRG.Pid)
                  .endElement();
          const prg_title = PRG.Title;
          if ( PRG.prima ) {
            prg_title += ' 1^TV';
          }
          const title_el = prg_el.startElement('title').writeAttribute('lang', 'it')
                  .text(prg_title)
                  .endElement();
          const genre_el = prg_el.startElement('category').writeAttribute('lang', 'it')
                  .text(PRG.Genre)
                  .endElement();
          const subgenre_el = prg_el.startElement('category').writeAttribute('lang', 'it')
                  .text(PRG.Subgenre)
                  .endElement();
          if ( PRG.Poster ) {
            const thumbnail_url_el = prg_el.startElement('icon')
                    .text(PRG.Poster)
                    .endElement();
          }
          const description_el = prg_el.startElement('desc').writeAttribute('lang', 'it')
                  .text(PRG.Description)
                  .endElement();
          const country_el = prg_el.startElement('country')
                  .text('IT')
                  .endElement();
          const subtitles_el = prg_el.startElement('sub-title').writeAttribute('lang', 'it')
                  .text( PRG.data.desc )
                  .endElement();
          const credits_el = prg_el.startElement('credits')
                  .endElement();


          if ( PRG.Episode ) {
            prg_el.startElement('episode-num')
                  .writeAttribute('system', 'onscreen')
                  .text( PRG.Episode )
                  .endElement();
          }

          prg_el.endElement();
        }
      }

    }

  }

  TV.endElement();
  XW.endDocument();

  return XW;
}


module.exports = {cleanUpString, request, createXMLTV, Log, setLogLevel, computeChannelStreamUrl, _URL_, urlShouldBeComputed};
