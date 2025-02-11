const { extname } = require('path')
const merge = require('deepmerge')
const namespace = 'biketag'
let singleton

class BikeTagModel {
    constructor(opts) {
        return merge(
            {
                author_flair: '',
                foundAt: '',
                credit: '',
                hint: '',
                gps: '',
                discussionLink: '',
                link: '',
                timestamp: null,
                currentTagNumber: -1,
                currentTagURL: '',
                currentTagURLExt: '',
                currentTagURLThumb: '',
                imgurBaseUrl: '',
                previousMysteryTagNumber: -1,
                previousMysteryTag: {},
                proofTagURL: '',
                proofTagNumber: -1,
            },
            opts,
        )
    }
}
class BikeTagApi {
    /// TODO: add jsdocs here and tie this class to the controller in controllers/api/index using res.locals
    constructor(logger = (m) => m, cache) {
        const nodeCache = require('node-cache')
        const { Client: GoogleMapsClient } = require('@googlemaps/google-maps-services-js')

        const cacheOptions = {
            stdTTL: 600,
            checkperiod: 450,
        }
        this.cacheKeys = {
            albumHash: `imgur::`,
            redditPosts: `reddit::`,
            bikeTagImage: `biketag::`,
            bikeTagsByUser: `usertags::`,
            hintText: `hint::`,
            creditText: `credit::`,
            locationText: `gps::`,
            tagNumberText: `tag::`,
            imagesText: `images::`,
            gpsLocationText: `gps::`,
        }
        this.setLogger(logger)
        this.setCache(cache || new nodeCache(cacheOptions, this.cacheKeys))
        this.googleMapsClient = new GoogleMapsClient({})
        this.imgur = require('imgur')
        this.reddit = require('snoowrap')
        this.sanity = require('@sanity/client')

        this.log(`BikeTag Cache Configured`, cache)
    }

    getBikeTagImages(imgurClientID, albumHash, callback, uncached = false) {
        const cacheKey = `${this.cacheKeys.albumHash}${imgurClientID}::${albumHash}`
        const getBikeTagImagesResponse = this.cache.get(cacheKey)

        if (!getBikeTagImagesResponse || uncached) {
            return this.getImgurAlbumInfo(imgurClientID, albumHash, (data) => {
                const images = this.getImagesByBikeTagNumber(data.images)
                this.cache.set(cacheKey, images)

                this.log('got new getBikeTagImages', { cacheKey, image: { images } })
                return callback(images)
            }).catch((e) => console.log('ERROR: getBikeTagImages:', { e }))
        } else {
            this.log('getting cached getBikeTagImages', { cacheKey, getBikeTagImagesResponse })
            return callback(getBikeTagImagesResponse)
        }
    }

    getBiketagImageUrl(url, size = '') {
        const ext = extname(url)
        /// Make sure the image type is supported
        if (['.jpg', '.jpeg', '.png', '.bmp'].indexOf(ext) === -1) return url

        switch (size) {
            default:
            case 'original':
            case '':
                break

            case 'small':
                size = 's'
            case 's':
                break

            case 'medium':
                size = 's'
            case 'm':
                break

            case 'large':
                size = 'l'
            case 'l':
                break
        }

        return url.replace(ext, `${size}${ext}`)
    }

    getBikeTagFromSanity(sanityOptions, tagnumber, game, gameRef) {
        const client = sanityClient(sanityOptions)
        const bikeTagImagesQuery = `*[_type == "tag" && game._ref == $gameRef && tagnumber == $tagnumber]`

        if (gameRef) {
            return client.fetch(bikeTagImagesQuery, { gameRef, tagnumber })
        }

        return client
            .fetch(`*[_type == "game" && name == $game][0]`, { game })
            .then((foundGame) =>
                client.fetch(bikeTagImagesQuery, { gameRef: foundGame._ref, tagnumber }),
            )
    }

    getBikeTagsFromSanity(sanityOptions, game, gameRef) {
        const client = sanityClient(sanityOptions)
        const bikeTagImagesQuery = `*[_type == "tag" && game._ref == $gameRef]`

        if (gameRef) {
            return client.fetch(bikeTagImagesQuery, { gameRef })
        }

        return client
            .fetch(`*[_type == "game" && name == $game][0]`, { game })
            .then((foundGame) => client.fetch(bikeTagImagesQuery, { gameRef: foundGame._ref }))
    }

    getBikeTagInformation(
        imgurClientID,
        tagNumberRequested,
        albumHash,
        callback,
        uncached = false,
    ) {
        const cacheKey = `${this.cacheKeys.bikeTagImage}${albumHash}::${tagNumberRequested}`
        const getBikeTagInformationResponse = this.cache.get(cacheKey)

        if (!getBikeTagInformationResponse || uncached) {
            return this.getBikeTagImages(
                imgurClientID,
                albumHash,
                (images) => {
                    if (images.length) {
                        const currentTagNumber = this.getBikeTagNumberFromImage(images[0])
                        const tagNumber =
                            tagNumberRequested == 'current'
                                ? currentTagNumber
                                : parseInt(tagNumberRequested)

                        const tagData = {
                            tagNumberRequested,
                        }
                        const proofTagNumber = tagNumber > 1 ? tagNumber - 1 : 1
                        const mysteryTagNumber = tagNumber > 1 ? tagNumber : 1
                        const previousMysteryTagNumber = proofTagNumber > 1 ? tagNumber - 1 : 1

                        const currentTagIndex = this.getBikeTagNumberIndexFromImages(
                            images,
                            mysteryTagNumber,
                        )
                        const proofTagIndex = this.getBikeTagNumberIndexFromImages(
                            images,
                            proofTagNumber,
                            true,
                        )
                        const previousMysterTagIndex = this.getBikeTagNumberIndexFromImages(
                            images,
                            previousMysteryTagNumber,
                        )

                        if (currentTagIndex === -1) {
                            return callback(null)
                        }

                        const currentTag = images[currentTagIndex]
                        const currentTagURL = currentTag.link
                        const currentTagURLExt = extname(currentTagURL)
                        const currentDescription = currentTag.description || ''
                        const currentTitle = currentTag.title || ''
                        const proofTag = images[proofTagIndex] || {}
                        // const proofTitle = proofTag.title
                        const proofDescription = proofTag.description
                        const imgurBaseUrl = 'https://imgur.com'
                        const creditSplit = proofDescription
                            ? proofDescription.split('by')
                            : currentDescription.split('by')
                        const hintSplit = currentDescription.split('hint:')
                        const discussionSplit = currentTitle.split('{')
                        const gpsSplit = currentTitle.split('(')

                        tagData.discussionLink =
                            discussionSplit.length > 1 ? discussionSplit[1].replace('}', '') : ''
                        tagData.gps =
                            gpsSplit.length > 1
                                ? gpsSplit[1].substring(0, gpsSplit[1].indexOf(')'))
                                : ''
                        tagData.imgurBaseUrl = imgurBaseUrl
                        tagData.image = currentTag
                        tagData.timestamp = currentTag.timestamp
                        tagData.currentTagNumber = mysteryTagNumber
                        tagData.currentTagURL = currentTagURL
                        tagData.currentTagURLExt = currentTagURLExt
                        tagData.currentTagURLThumb = currentTagURL.replace(
                            currentTagURLExt,
                            `m${currentTagURLExt}`,
                        )
                        tagData.credit = creditSplit[creditSplit.length - 1].trim()
                        tagData.hint =
                            hintSplit.length > 1
                                ? hintSplit[1].substring(0, hintSplit[1].lastIndexOf(')')).trim()
                                : ''
                        tagData.previousMysteryTag =
                            previousMysterTagIndex !== -1 ? images[previousMysterTagIndex] : {}
                        tagData.previousMysteryTagNumber = previousMysteryTagNumber
                        tagData.proofTag = proofTag
                        tagData.proofTagURL = proofTag ? `${imgurBaseUrl}/${proofTag.id}` : null
                        tagData.proofText = proofDescription
                        tagData.proofTagNumber = proofTagNumber

                        const bikeTagInformation = new BikeTagModel(tagData)

                        // if (!uncached)
                        this.cache.set(cacheKey, bikeTagInformation)
                        this.log('got new getBikeTagInformation', { cacheKey, bikeTagInformation })

                        return callback(bikeTagInformation)
                    }

                    return callback(null)
                },
                uncached,
            )
        } else {
            this.log('getting cached getBikeTagInformation', {
                cacheKey,
                getBikeTagInformationResponse,
            })
            return callback(getBikeTagInformationResponse)
        }
    }

    async getBikeTagInformationFromRedditData(redditPostData, config = {}) {
        if (!redditPostData.tagNumbers) {
            /// TODO: handle a link that is an image gallery and has only one tag number attached
            redditPostData.tagNumbers = [redditPostData.tagNumber]
        }

        const imgurBaseUrl = `https://imgur.com`
        const mysteryTagNumber = Math.max(...redditPostData.tagNumbers)
        const proofTagNumber = mysteryTagNumber - 1
        const previousMysteryTagNumber = proofTagNumber > 1 ? mysteryTagNumber - 1 : 1
        const currentTagURLIndex = redditPostData.tagNumbers.indexOf(mysteryTagNumber)
        const currentTagURL = redditPostData.tagImageURLs[currentTagURLIndex]
        const proofTagUrlIndex = redditPostData.tagNumbers.indexOf(previousMysteryTagNumber)
        const proofTagURL =
            proofTagUrlIndex !== -1 ? redditPostData.tagImageURLs[proofTagUrlIndex] : null
        const currentTagURLExt = extname(currentTagURL)
        let gps = redditPostData.gps

        if (!gps && config.auth.google) {
            await this.googleMapsClient
                .findPlaceFromText({
                    params: {
                        key: config.auth.google.opts.apiKey,
                        input: redditPostData.foundAt,
                        inputtype: 'textquery',
                        fields: 'formatted_address,name,geometry',
                        locationbias: 'circle:60660@41.8781,-87.6298',
                    },
                    timeout: 1000, // milliseconds
                })
                .then((r) => {
                    const candidates = r.data.candidates
                    const chosenGeometry = candidates.length
                        ? candidates[0].geometry.location
                        : null
                    gps = chosenGeometry ? `${chosenGeometry.lat},${chosenGeometry.lng}` : null
                })
                .catch((e) => {
                    // console.log(e.response.data.error_message || `error ${e.response.status}`)
                })
        }

        const tagData = {
            author_flair: redditPostData.author_flair,
            foundAt: redditPostData.foundAt,
            credit: redditPostData.credit,
            hint: redditPostData.hint,
            gps,
            discussionLink: `https://redd.it/${redditPostData.id}`,
            link: currentTagURL,
            timestamp: redditPostData.timestamp,
            currentTagNumber: mysteryTagNumber,
            currentTagURL,
            currentTagURLExt,
            currentTagURLThumb: currentTagURL.replace(currentTagURLExt, `m${currentTagURLExt}`),
            imgurBaseUrl,
            previousMysteryTagNumber,
            previousMysteryTag: {},
            proofTagURL,
            proofTagNumber,
        }

        tagData.image = {
            title: this.getBikeTagTitleFromData(tagData),
            description: this.getBikeTagDescriptionFromData(tagData),
            url: currentTagURL,
            link: currentTagURL,
            number: mysteryTagNumber,
        }
        if (proofTagNumber > 0) {
            tagData.proofTag = {
                title: this.getBikeTagProofTitleFromData(tagData),
                description: this.getBikeTagProofDescriptionFromData(tagData),
                url: proofTagURL,
                link: proofTagURL,
                number: proofTagNumber,
            }
            tagData.proofText = tagData.proofTag.description
        } else {
            tagData.proofText = ''
            tagData.proofTag = {}
        }
        const bikeTagInformation = new BikeTagModel(tagData)

        return bikeTagInformation
    }

    getBikeTagDescriptionFromData(data) {
        return `#${data.currentTagNumber} tag ${data.hint ? `(hint: ${data.hint})` : ''} by ${
            data.credit
        }`
    }

    getBikeTagTitleFromData(data) {
        return `${data.gps ? `(${data.gps})` : ''} {${
            data.discussionLink ? data.discussionLink : ''
        }}`
    }

    getBikeTagProofDescriptionFromData(data) {
        return `#${data.proofTagNumber} proof${
            data.foundAt ? ` found at (${data.foundAt})` : ''
        } by ${data.credit}`
    }

    getBikeTagProofTitleFromData(data) {
        return `(${data.gps ? data.gps : ''})`
    }

    getBikeTagNumberFromImage(image) {
        return image.description ? this.getTagNumbersFromText(image.description)[0] : -1
    }

    getBikeTagNumberFromRequest(req) {
        const pathTagNumber = parseInt(req.params.tagnumber)
        const bodyTagNumber = parseInt(req.body.tagnumber)
        // console.log({ bodyTagNumber, pathTagNumber, body: req.body })
        if (!!pathTagNumber) return pathTagNumber
        if (!!bodyTagNumber) return bodyTagNumber

        return 'current'
    }

    getBikeTagNumberIndexFromImages(images, tagNumber, proof = false) {
        let tagNumberIndex = images.length + 1 - (tagNumber - (tagNumber % 2) + 1) * 2

        const verifyTagNumber = function (index) {
            if (!images[index] || !images[index].description) {
                return false
            }

            let compare = `#${tagNumber} tag`
            if (proof) {
                compare = `#${tagNumber} proof`
            }

            return index > -1 && !!images[index]
                ? images[index].description.indexOf(compare) !== -1
                : false
        }

        if (verifyTagNumber(tagNumberIndex)) {
            return tagNumberIndex
        }
        if (tagNumberIndex < images.length + 1 && verifyTagNumber(tagNumberIndex + 1)) {
            return tagNumberIndex + 1
        }
        if (tagNumberIndex > 0 && verifyTagNumber(tagNumberIndex - 1)) {
            return tagNumberIndex - 1
        }

        for (let i = 0; i < images.length; ++i) {
            if (verifyTagNumber(i)) {
                return i
            }
        }

        return -1
    }

    async getBikeTagPostsFromSubreddit(config, subreddit, opts, callback, uncached = false) {
        if (typeof opts === 'function') {
            callback = opts
            opts = {}
        }

        const cacheKey = `${this.cacheKeys.redditPosts}::${subreddit}::${JSON.stringify(opts)}`
        let getBikeTagPostsFromSubredditResponse = this.cache.get(cacheKey)

        if (!getBikeTagPostsFromSubredditResponse || uncached) {
            const r = new this.reddit(config.auth)
            const query = `subreddit:${subreddit} title:Bike Tag`
            opts = merge(
                {
                    sort: 'new',
                    limit: 10,
                    time: 'year',
                },
                opts,
            )

            await r
                .getSubreddit(subreddit)
                .search({ query, ...opts })
                .then((response) => {
                    getBikeTagPostsFromSubredditResponse = response
                })

            this.cache.set(cacheKey, getBikeTagPostsFromSubredditResponse)
        }

        return callback(getBikeTagPostsFromSubredditResponse)
    }

    /// TODO: cache this response
    getBikeTagsByUser(imgurClientID, albumHash, username, callback, uncached = false) {
        const cacheKey = `${this.cacheKeys.bikeTagsByUser}${albumHash}::${username}`
        const getBikeTagsByUserResponse = this.cache.get(cacheKey)

        if (!getBikeTagsByUserResponse || uncached) {
            return this.getBikeTagImages(imgurClientID, albumHash, (images) => {
                if (username) {
                    const usersImages = images.filter((i) => {
                        return i.description.indexOf(username) !== -1
                    })

                    return callback(usersImages)
                } else {
                    const usernames = [],
                        imagesGroupedByUsername = {}
                    const sortedImages = images.sort((a, b) => {
                        const usernameA = this.getBikeTagUsernameFromImage(a)
                        const usernameB = this.getBikeTagUsernameFromImage(b)

                        // record the username
                        if (usernames.indexOf(usernameA) === -1) usernames.push(usernameA)

                        return ('' + usernameA + '').localeCompare(usernameB)
                    })
                    usernames.forEach((username) => {
                        imagesGroupedByUsername[username] = sortedImages.filter((i) => {
                            const u = this.getBikeTagUsernameFromImage(i)
                            return u ? u.localeCompare(username) === 0 : ''
                        })
                    })

                    this.cache.set(cacheKey, imagesGroupedByUsername)

                    return callback(imagesGroupedByUsername)
                }
            })
        } else {
            this.log('getting cached getBikeTagInformation', {
                cacheKey,
                getBikeTagInformationResponse: getBikeTagsByUserResponse,
            })
            return callback(getBikeTagsByUserResponse)
        }
    }

    async getBikeTagsFromRedditPosts(posts) {
        let selftext = '',
            postBody,
            isSelfPost = true
        const postTexts = []

        for (let i = 0; i < posts.length; i++) {
            const p = posts[i]

            const imgurBaseUrl = '://imgur.com'
            const galleryBaseUrl = `${imgurBaseUrl}/gallery/`
            const albumBaseUrl = `${imgurBaseUrl}/a/`

            if (p.selftext && p.selftext.length) {
                postBody = selftext = p.selftext
            } else if (p.media && p.media.oembed) {
                /// Might be a single tag?
                postBody = `${p.media.oembed.title} ${p.media.oembed.description}`
                selftext = p.media.oembed.url
                isSelfPost = false
            }

            let tagImageURLs = this.getImageURLsFromText(selftext)
            let tagNumbers = this.getTagNumbersFromText(postBody)
            let hint = this.getHintFromText(postBody)
            let foundAt = this.getFoundLocationFromText(postBody)
            let gps = this.getGPSLocationFromText(postBody)
            let credit = this.getCreditFromText(postBody, `u/${p.author.name}`)
            let timestamp = p.created_utc

            let directImageLinks = [],
                directImageLinksNumbers = tagNumbers
            for (let u = 0; u < tagImageURLs.length; u++) {
                const imageUrl = tagImageURLs[u]
                const galleryIndex = imageUrl.indexOf(galleryBaseUrl)
                const albumIndex = imageUrl.indexOf(albumBaseUrl)
                const imageUrlIsGallery = galleryIndex !== -1
                const imageUrlIsAlbum = albumIndex !== -1
                const imageIsMultipleIndex = imageUrlIsGallery ? galleryIndex : albumIndex
                const imageIsMultipleLength = imageUrlIsGallery
                    ? galleryBaseUrl.length
                    : albumBaseUrl.length

                /// If the one image is a gallery, we need to go get it's images and parse those
                if (imageUrlIsGallery || imageUrlIsAlbum) {
                    const imgurUrlGetMethod = imageUrlIsGallery
                        ? this.imgur.getGalleryInfo
                        : this.imgur.getAlbumInfo
                    const galleryID = imageUrl.substring(
                        imageIsMultipleIndex + imageIsMultipleLength,
                    )
                    const galleryInfoResponse = await imgurUrlGetMethod(galleryID)

                    if (galleryInfoResponse) {
                        galleryInfoResponse.images.forEach((image) => {
                            const imageText = `${image.title} ${image.description}`
                            const newImageNumbers = this.getTagNumbersFromText(imageText)

                            if (newImageNumbers.length) {
                                directImageLinksNumbers.splice(u, 1)
                                directImageLinksNumbers = directImageLinksNumbers.concat(
                                    newImageNumbers,
                                )
                            }

                            directImageLinks.push(image.link)

                            /// TODO: might need a conversion to utc here
                            timestamp = image.datetime || timestamp
                            hint = hint || this.getHintFromText(imageText)
                            foundAt = foundAt || this.getFoundLocationFromText(postBody)
                            credit = credit || this.getCreditFromText(postBody)
                            gps = gps || this.getGPSLocationFromText(postBody)
                        })
                        credit = credit || info.account_url
                    } else {
                        console.log('ERROR: getBikeTagsFromRedditPosts', {
                            imageUrl,
                            galleryInfoResponse,
                        })
                    }
                } else {
                    directImageLinks.push(imageUrl)
                }
            }

            if (!directImageLinksNumbers.length) {
                /// No tag numbers found?
                this.log({ unreadableRedditPost: p })
            } else {
                if (!foundAt) {
                    foundAt = postBody
                    const removeStringFromFoundAt = (s) => (foundAt = foundAt.replace(s, ''))
                    const foundAtRemnantRegex = /\s*at\s*/gi
                    tagImageURLs.forEach(removeStringFromFoundAt)
                    tagNumbers.forEach((s) => removeStringFromFoundAt(`#${s}`))

                    if (credit) removeStringFromFoundAt(`(@|#|u/)?${credit}`)
                    if (gps)
                        removeStringFromFoundAt(
                            new RegExp(
                                `(@|#)?${gps.replace(' ', '.?').replace(',', 's?')}|(@|#)?${gps}`,
                                'gi',
                            ),
                        )
                    if (hint)
                        removeStringFromFoundAt(
                            new RegExp(`(\()?(hint:?)?\s*(${hint})(\s?\))?`, 'gi'),
                        )

                    removeStringFromFoundAt(/\[(?:bike)?\s*tag\s*\d*\]\(\s*\)/gi)
                    removeStringFromFoundAt(/\[\s*\]\(http.*\)/gi)
                    removeStringFromFoundAt(/\[(?!(?:bike)?\s*tag\s*).*\]\(.*\)/gi)
                    removeStringFromFoundAt(/\[(?:bike)?\s*tag\s*\d*\s*-/gi)
                    removeStringFromFoundAt(/\]\(\s*\)/gi)
                    removeStringFromFoundAt(/\r?\n?/gi)
                    removeStringFromFoundAt(/\\/gi)
                    removeStringFromFoundAt(/\(\s*\)/gi)
                    removeStringFromFoundAt(/&#.*;/gi)

                    if (foundAt.endsWith('at') || foundAt.endsWith('at '))
                        removeStringFromFoundAt(foundAtRemnantRegex)
                    if (foundAt.startsWith('-') || foundAt.startsWith(' -'))
                        removeStringFromFoundAt(/^\s*-/i)
                    if (foundAt.startsWith(',') || foundAt.startsWith(' ,'))
                        removeStringFromFoundAt(/^\s*,/i)

                    foundAt = foundAt.trim()
                }

                postTexts.push({
                    id: p.id,
                    isSelfPost,
                    selftext,
                    postBody,
                    timestamp,
                    tagNumbers: directImageLinksNumbers,
                    tagImageURLs: directImageLinks,
                    credit,
                    gps,
                    foundAt,
                    hint,
                    author_flair: p.author_flair_text,
                })
            }
        }

        return postTexts
    }

    async postBikeTagToAllTheThings(currentTagInfo, subdomainConfig, game) {
        // check to see if reddit link already exists, if so then skip posting it
        if (
            currentTagInfo.discussionLink &&
            currentTagInfo.discussionLink.indexOf('https://redd.it/') !== -1
        ) {
            return {
                message: 'tag has already been posted to Reddit',
                url: currentTagInfo.discussionLink,
            }
        }

        subdomainConfig.currentTagInfo = currentTagInfo
        let redditSelfPostName
        const { imgurAccessToken } = subdomainConfig.imgur

        const selfPostCallback = async function (response) {
            if (!response.error && response.selfPostName) {
                this.log.status('posted to reddit', response)
                redditSelfPostName = response.selfPostName

                if (response.crossPostName) {
                    const globalRedditAccount =
                        this.app.config.authentication.reddit || subdomainConfig.reddit
                    const regionName = `${subdomainConfig.requestSubdomain
                        .charAt(0)
                        .toUpperCase()}${subdomainConfig.requestSubdomain.slice(1)}`
                    const postFlair = subdomainConfig.reddit.globalPostFlair
                        ? subdomainConfig.reddit.globalPostFlair
                        : regionName
                    subdomainConfig.auth.username = globalRedditAccount.username
                    subdomainConfig.auth.password = globalRedditAccount.password

                    /// TODO: unsticky previous BikeTag post

                    await this.setBikeTagPostFlair(
                        subdomainConfig,
                        { selfPostName: response.crossPostName },
                        postFlair,
                        (response) => {
                            this.log.status('setBikeTagPostFlair', response)
                        },
                    ).catch((error) => {
                        this.log.error(`setBikeTagPostFlair failed`, error)
                    })
                }

                const discussionUrl = ` https://redd.it/${response.selfPostName.replace('t3_', '')}`
                const updatedImage = {
                    id: subdomainConfig.currentTagInfo.image.id,
                    title: `${subdomainConfig.currentTagInfo.image.title} {${discussionUrl}}`,
                    description: subdomainConfig.currentTagInfo.image.description,
                }

                await this.updateImgurInfo(imgurAccessToken, updatedImage, (response) => {
                    this.log.status('updateImgurInfo', response, updatedImage)
                }).catch((error) => {
                    this.log.error(`updateImgurInfo failed`, {
                        error,
                        updatedImage,
                    })
                })

                return { success: 'tag was successfully posted to Reddit!', url: discussionUrl }
            }

            return { error: response }
        }

        const liveThreadCommentCallback = async (response) => {
            console.log('liveThreadCommentCallback', { response })
            if (!response.error && response.selfPostName) {
                this.log.status('posted comment to reddit live thread', {
                    liveThread: subdomainConfig.reddit.liveThread,
                    response,
                })
                const redditT3ID = redditSelfPostName ? redditSelfPostName : response.id
				const discussionUrl = redditT3ID && redditT3ID.length
					? ` https://redd.it/${redditT3ID.replace('t3_', '')}`
					: ''

                if (discussionUrl) {
                    const updatedImage = {
                        id: subdomainConfig.currentTagInfo.image.id,
                        title: `${subdomainConfig.currentTagInfo.image.title} {${discussionUrl}}`,
                        description: subdomainConfig.currentTagInfo.image.description,
                    }

                    await this.updateImgurInfo(imgurAccessToken, updatedImage, (response) => {
                        this.log.status('updateImgurInfo', response, updatedImage)
                    }).catch((error) => {
                        this.log.error(`updateImgurInfo failed`, {
                            error,
                            updatedImage,
                        })
                    })
                }

                return { success: response, url: discussionUrl }
            }
        }

        let redditAutoPostMethod = this.postCurrentBikeTagToRedditSelfPost
        let redditAutoPostCallback = selfPostCallback.bind(this)

        if (subdomainConfig.reddit.disableSelfPost) {
            redditAutoPostMethod = subdomainConfig.reddit.liveThread
                ? this.postCurrentBikeTagToRedditLiveThread
                : () => {
                      return { error: 'autoposting disabled' }
                  }
            redditAutoPostCallback = liveThreadCommentCallback.bind(this)
        } else if (
            subdomainConfig.reddit.liveThread &&
            subdomainConfig.reddit.autoPostToliveThread
        ) {
            /// Create the self post first
            await redditAutoPostMethod(
                subdomainConfig,
                redditAutoPostCallback,
                this.app.renderSync.bind(this.app),
            )

            subdomainConfig.redditSelfPostName = redditSelfPostName
            redditAutoPostMethod = biketag.postCurrentBikeTagToRedditLiveThread.bind(biketag)
            redditAutoPostCallback = liveThreadCommentCallback.bind(this)
        }

        return redditAutoPostMethod(
            subdomainConfig,
            redditAutoPostCallback,
            this.app.renderSync.bind(this.app),
        )
    }

    getBikeTagUsernameFromImage(image) {
        return this.getCreditFromText(image.description)
    }

    async postCurrentBikeTagToRedditLiveThread(config, tagNumberToPost, callback, renderer) {
        /// Support getting the current tag if no number is passed as second param
        if (typeof tagNumberToPost === 'function') {
            renderer = callback
            callback = tagNumberToPost
        }
        console.log('postCurrentBikeTagToRedditLiveThread')

        /// Otherwise, fetch the most recent image
        tagNumberToPost = tagNumberToPost || config.currentTagInfo.currentTagNumber
        let currentTagInfo = config.currentTagInfo

        /// Support passing an image in instead of the tagNumber
        if (typeof tagNumberToPost === 'object') {
            currentTagInfo = tagNumberToPost
            tagNumberToPost = currentTagInfo.currentTagNumber
        } else {
            await this.getBikeTagInformation(
                config.imgur.imgurClientID,
                config.currentTagInfo.currentTagNumber,
                config.imgur.albumHash,
                (tagData) => {
                    currentTagInfo = tagData
                },
            )
        }

        // let existingRedditPost = null
        // /// TODO: Check to see if the tag has already been posted to the given subreddit
        // await this.getBikeTagPostsFromSubreddit(
        //     config,
        //     config.reddit.subreddit,
        //     { sort: 'new' },
        //     async (posts) => {
        //         if (!posts || posts.error) {
        //             return res.json({ error: posts.error })
        //         }
        //         const bikeTagPosts = await this.getBikeTagsFromRedditPosts(posts)
        //         existingRedditPost = bikeTagPosts.reduce((o, b) => {
        //             o = o || b.currentTagNumber === currentTagInfo.currentTagNumber
        //             return o
        //         }, false)
        //     },
        //     true,
        // )

        // if (existingRedditPost) {
        //     return callback({ error: `Tag has already been posted to Reddit` })
        // }

        let r = new this.reddit(config.auth)

        currentTagInfo.host = config.host

        const renderOpts = merge(currentTagInfo, {
            redditSelfPostLink: config.redditSelfPostName
                ? `https://redd.it/${config.redditSelfPostName.replace('t3_', '')}`
                : undefined,
            region: config.region,
            subdomainIcon: config.images.logo
                ? `/public/img/${config.images.logo}${
                      config.images.logo.indexOf('.') === -1 ? `-small.png` : ''
                  }`
                : config.meta.image,
            host: `${config.requestSubdomain ? `${config.requestSubdomain}.` : ''}${
                config.requestHost || config.host
            }`,
            mapLink:
                config.map && config.map.url
                    ? `[Check out the map for ${config.region}!](${config.map.url})`
                    : '',
        })

        const currentTagTemplate = renderer('reddit/comment', renderOpts)

        /// Create a new BikeTag comment
        return r
            .getLivethread(config.reddit.liveThread)
            .addUpdate(currentTagTemplate)
            .then((response) => {
                console.log({ liveThreadResponse: response })
                callback(response)
            })
    }

    async postCurrentBikeTagToRedditSelfPost(config, tagNumberToPost, callback, renderer) {
        /// Support getting the current tag if no number is passed as second param
        if (typeof tagNumberToPost === 'function') {
            renderer = callback
            callback = tagNumberToPost
        }

        /// Otherwise, fetch the most recent image
        tagNumberToPost = tagNumberToPost || config.currentTagInfo.currentTagNumber
        let currentTagInfo = config.currentTagInfo

        /// Support passing an image in instead of the tagNumber
        if (typeof tagNumberToPost === 'object') {
            currentTagInfo = tagNumberToPost
            tagNumberToPost = currentTagInfo.currentTagNumber
        } else {
            await this.getBikeTagInformation(
                config.imgur.imgurClientID,
                config.currentTagInfo.currentTagNumber,
                config.imgur.albumHash,
                (tagData) => {
                    currentTagInfo = tagData
                },
            )
        }

        let existingRedditPost = null
        /// TODO: Check to see if the tag has already been posted to the given subreddit
        await this.getBikeTagPostsFromSubreddit(
            config,
            config.reddit.subreddit,
            { sort: 'new' },
            async (posts) => {
                if (!posts || posts.error) {
                    return res.json({ error: posts.error })
                }
                const bikeTagPosts = await this.getBikeTagsFromRedditPosts(posts)
                existingRedditPost = bikeTagPosts.reduce((o, b) => {
                    o = o || b.currentTagNumber === currentTagInfo.currentTagNumber
                    return o
                }, false)
            },
            true,
        )

        if (existingRedditPost) {
            return callback({ error: `Tag has already been posted to Reddit` })
        }

        /// Make sure we're working with the most up to date image data
        let r = new this.reddit(config.auth),
            selfPostName,
            crossPostName,
            error

        currentTagInfo.host = config.host

        const renderOpts = merge(currentTagInfo, {
            region: config.region,
            subdomainIcon: config.images.logo
                ? `/public/img/${config.images.logo}${
                      config.images.logo.indexOf('.') === -1 ? `-small.png` : ''
                  }`
                : config.meta.image,
            host: `${config.requestSubdomain ? `${config.requestSubdomain}.` : ''}${
                config.requestHost || config.host
            }`,
            mapLink:
                config.map && config.map.url
                    ? `[Check out the map for ${config.region}!](${config.map.url})`
                    : '',
        })

        const currentTagTemplate = renderer('reddit/post', renderOpts)
        const flairOpts = {
            text: config.postFlair ? config.postFlair : 'BikeTag',
        }

        /// TODO: make this check for an id string more intelligent
        if (config.postFlair && config.postFlair.indexOf('-')) {
            flairOpts.flair_template_id = config.postFlair
            flairOpts.text = undefined
        }

        /// Create a new BikeTag self post
        const redditRequest = r.getSubreddit(config.reddit.subreddit).submitSelfpost({
            title: `Bike Tag #${currentTagInfo.currentTagNumber}`,
            text: currentTagTemplate.replace('<pre>', '').replace('</pre>', ''),
        })

        if (config.reddit.assignFlair) await redditRequest.assignFlair(flairOpts)
        if (config.reddit.approveNewPost) await redditRequest.approve()
        if (config.reddit.stickyNewPost) await redditRequest.sticky()
        if (config.reddit.distinguishAsMod) await redditRequest.distinguish()

        await redditRequest.then((response) => {
            error = response.error
            selfPostName = response.name
        })

        /// this crosspost can't be submitted with a different user
        await r
            .getSubmission(selfPostName)
            .submitCrosspost({
                subredditName: 'biketag',
                title: `[X-Post r/${config.reddit.subreddit}] Bike Tag #${config.currentTagInfo.currentTagNumber} (${config.region})`,
                resubmit: false,
            })
            .then((response) => {
                error = error || response.error
                crossPostName = response.name
            })

        callback({ error, crossPostName, selfPostName })
    }

    async setBikeTagCrossPostFlair(config, flair, callback) {
        const flairOpts = {
            text: flair ? flair : 'BikeTag',
        }

        /// TODO: make this check for an id string more intelligent
        if (flair && flair.indexOf('-')) {
            flairOpts.flair_template_id = flair
            flairOpts.text = undefined
        }

        const r = new this.reddit(config.auth)

        await r
            .getSubmission(redditData.name)
            .fetch()
            .then((submission) => {
                if (!!submission) {
                    return r
                        .getSubreddit(config.reddit.subreddit)
                        .assignFlair(flairOpts)
                        .then(callback)
                        .catch(callback)
                } else {
                    console.error('post to reddit error!')
                }
            })
            .catch(callback)
    }

    async setBikeTagImages(
        imgurClientID,
        imgurAuthorization,
        images,
        albumHash,
        imagesType = 'Url',
        callback,
    ) {
        this.imgur.setClientId(imgurClientID)
        this.imgur.setAccessToken(imgurAuthorization.replace('Bearer ', ''))

        const self = this
        const newImages = []
        const updatedTagsInformation = []

        for (let i = 0; i < images.length; i++) {
            const imageInfo = images[i]
            const image = imageInfo.image

            /// Put some time between upload here
            await this.getBikeTagInformation(
                imgurClientID,
                imageInfo.currentTagNumber,
                albumHash,
                (existingImage) => {
                    if (existingImage) {
                        const updateImage = {
                            id: existingImage.image.id,
                            title: image.title || existingImage.image.title,
                            description: image.description || existingImage.image.description,
                        }

                        /// Update the image now
                        return imgur
                            .updateInfo(updateImage.id, updateImage.title, updateImage.description)
                            .then((json) => {
                                if (json.success) {
                                    self.log(`image updated (${updateImage.id})`, { json })
                                    updatedTagsInformation.push({
                                        id: updateImage.id,
                                        updated: true,
                                        proofImage: false,
                                    })

                                    if (existingImage.proofTag && existingImage.proofTag.id) {
                                        updateImage.id = existingImage.proofTag.id
                                        updateImage.title = imageInfo.proofTag.title
                                        updateImage.description = imageInfo.proofTag.description

                                        // console.log({updateImage, proofTag: imageInfo.proofTag})

                                        return imgur
                                            .updateInfo(
                                                updateImage.id,
                                                updateImage.title,
                                                updateImage.description,
                                            )
                                            .then((json) => {
                                                if (json.success) {
                                                    self.log(
                                                        `proof image updated (${updateImage.id})`,
                                                        { json },
                                                    )
                                                    updatedTagsInformation.push({
                                                        id: updateImage.id,
                                                        updated: true,
                                                        proofImage: true,
                                                    })
                                                }
                                            })
                                    } else {
                                        newImages.push(imageInfo.proofTag)
                                    }
                                }
                            })
                    } else {
                        newImages.push(image)
                        newImages.push(imageInfo.proofTag)
                    }
                },
                true,
            )
        }

        /// Create the new images
        if (newImages.length) {
            await this.imgur.uploadImages(newImages, imagesType, albumHash).then((json) => {
                self.log(`[${newImages.length}] images uploaded to album ${albumHash}`)
                callback({
                    updatedTagsInformation,
                    newTagsInformation: json.reduce((o, i) => {
                        o.push({
                            id: i.id,
                            updated: true,
                            proofImage: i.description.indexOf('proof') !== -1,
                        })

                        return o
                    }, []),
                })
            })
        } else {
            self.log(`no new images to upload`)
            callback({ updatedTagsInformation, newTagsInformation: null })
        }
    }

    async setBikeTagPostFlair(config, tagNumberToUpdate, flair, callback) {
        /// Support setting the current tag if no number is passed as second param
        if (typeof flair === 'function') {
            callback = flair
            flair = tagNumberToUpdate
        }

        /// Otherwise, fetch the most recent image
        tagNumberToUpdate = tagNumberToUpdate || config.currentTagInfo.currentTagNumber
        let redditPostName

        /// Support passing an object with the selfPostName in instead of the tagNumber
        if (typeof tagNumberToUpdate === 'object' && tagNumberToUpdate.selfPostName) {
            redditPostName = tagNumberToUpdate.selfPostName
        } else if (!config.currentTagInfo && tagNumberToUpdate.description) {
            config.currentTagInfo = { image: tagNumberToUpdate }
        } else if (!config.currentTagInfo) {
            await this.getBikeTagInformation(
                config.imgur.imgurClientID,
                config.currentTagInfo.currentTagNumber,
                config.imgur.albumHash,
                (tagData) => {
                    config.currentTagInfo = tagData
                },
            )
        }

        /// If the redditPostName was not passed in, parse it from the current image's description
        if (!redditPostName) {
            const searchRedditUrlPrefix = '://redd.it/'
            const redditUrlIndex = config.currentTagInfo.image.description.indexOf(
                searchRedditUrlPrefix,
            )

            /// If the reddit url doesn't exist in the image we can't udpate anything
            if (redditUrlIndex === -1) return callback(null)

            redditPostName = `t3_${config.currentTagInfo.image.description.substring(
                redditUrlIndex + searchRedditUrlPrefix.length,
            )}`
        }

        const flairOpts = {
            text: flair ? flair : 'BikeTag',
        }

        /// TODO: make this check for an id string more intelligent
        if (flair && flair.indexOf('-')) {
            flairOpts.flair_template_id = flair
            flairOpts.text = undefined
        }

        let r = new this.reddit(config.auth)
        return r.getSubmission(redditPostName).assignFlair(flairOpts).then(callback)
    }

    /// API passthroughs
    getImgurAlbumInfo(imgurClientID, albumHash, callback) {
        this.imgur.setClientId(imgurClientID)

        return this.imgur.getAlbumInfo(albumHash).then(callback)
    }

    updateImgurInfo(imgurAuthorization, image, callback) {
        this.imgur.setAccessToken(imgurAuthorization.replace('Bearer ', ''))

        return this.imgur.updateInfo(image.id, image.title, image.description).then(callback)
    }

    /// OTHER METHODS
    flushCache() {
        this.log('Flushing the cache')
        return this.cache.flushAll()
    }

    getImagesByBikeTagNumber(images = []) {
        return images.sort((image1, image2) => {
            const tagNumber1 = this.getBikeTagNumberFromImage(image1)
            const tagNumber2 = this.getBikeTagNumberFromImage(image2)

            const tagNumber1IsProof = tagNumber1 < 0
            const difference = Math.abs(tagNumber2) - Math.abs(tagNumber1)
            const sortResult = difference !== 0 ? difference : tagNumber1IsProof ? -1 : 1

            return sortResult
        })
    }

    getImagesByUploadDate(images = [], newestFirst) {
        if (!newestFirst) {
            return images.sort(
                (image1, image2) => new Date(image2.datetime) - new Date(image1.datetime),
            )
        }
        return images.sort(
            (image1, image2) => new Date(image1.datetime) - new Date(image2.datetime),
        )
    }

    getTagNumbersFromText(inputText, fallback) {
        const cacheKey = `${this.cacheKeys.tagNumberText}${inputText}`
        const existingParsed = this.cache.get(cacheKey)
        if (existingParsed) return existingParsed

        /// TODO: build out testers for all current games of BikeTag on Reddit
        const getTagNumbersRegex = new RegExp(
            /((?:(?:bike\s*)?(?:\s*tag)?)#(\d+)(?:(?:\s*tag)?|(?:\s*proof)?))|(?:\[(?:\s*bike\s*)(?:\s*tag\s*))#?(\d+)(?:(?:\])|(?:\s*.\s*.*\]))/gi,
        )
        const tagNumberText = inputText.match(getTagNumbersRegex)
        if (!tagNumberText) return fallback || []

        const tagNumbers = tagNumberText.reduce((numbers, text) => {
            let tagNumber = text.match(/\d+/)
            tagNumber = tagNumber && tagNumber.length ? tagNumber[0] : null

            if (!tagNumber) return numbers

            const number = Number.parseInt(tagNumber)
            if (numbers.indexOf(number) == -1) numbers.push(number)

            return numbers
        }, [])

        if (!tagNumbers.length && fallback) {
            this.cache.set(cacheKey, fallback)
            return fallback
        }

        this.cache.set(cacheKey, tagNumbers)
        return tagNumbers
    }

    getCreditFromText(inputText, fallback) {
        const cacheKey = `${this.cacheKeys.creditText}${inputText}`
        const existingParsed = this.cache.get(cacheKey)
        if (existingParsed) return existingParsed

        /// TODO: build out testers for all current games of BikeTag on Reddit
        const creditRegex = new RegExp(
            /((?:\[.*)?(?:proof\s*(?:found\s*at\s*)?(?:\(.*\))?\s*by\s*)(.*)(?:\])?)|((?:\[.*)?(?:tag\s*(?:\((?:hint:)?.*\))?\s*by\s*)(.*)(?:\])?)|((?:credit goes to:\s*)(.*)(?:\s*for))/gi,
        )
        const creditText = creditRegex.exec(inputText)
        if (!creditText) return fallback || null

        /// Weed out the results and get the one remaining match
        const tagCredits = creditText.filter((c) =>
            typeof c === 'string' &&
            (c.indexOf('tag ') === -1 || c.indexOf('tag') !== 0) &&
            (c.indexOf('proof ') === -1 || c.indexOf('proof') !== 0) &&
            c.indexOf('(hint:') === -1 &&
            (c.indexOf('by') === -1 || c.indexOf('by') !== 0)
                ? c
                : undefined,
        )

        if (!tagCredits.length && fallback) {
            this.cache.set(cacheKey, fallback)
            return fallback
        }

        const credit = tagCredits[0]
        this.cache.set(cacheKey, credit)

        /// Return just one credit, there should only be one anyways
        return credit
    }

    getFoundLocationFromText(inputText, fallback) {
        const cacheKey = `${this.cacheKeys.locationText}${inputText}`
        const existingParsed = this.cache.get(cacheKey)
        if (existingParsed) return existingParsed

        /// TODO: build out testers for all current games of BikeTag on Reddit
        const getFoundLocationRegex = new RegExp(
            /(?:found at \()(.+?)(?:\))|(?:\[(?:\s*bike\s*)(?:\s*tag\s*))#?(\d+)(?:(?:\])|(?:\s*.\s*(.*)\]))/gi,
        )
        const foundLocationText = getFoundLocationRegex.exec(inputText)

        if (!foundLocationText) {
            fallback = fallback || null
            this.cache.set(cacheKey, fallback)
            return fallback
        }

        const foundLocation = (foundLocationText[1] || '').trim()
        this.cache.set(cacheKey, foundLocation)

        return foundLocation
    }

    getHintFromText(inputText, fallback) {
        const cacheKey = `${this.cacheKeys.hintText}${inputText}`
        const existingParsed = this.cache.get(cacheKey)
        if (existingParsed) return existingParsed

        /// TODO: build out testers for all current games of BikeTag on Reddit
        const getTagNumbersRegex = new RegExp(/(?:hint:\s*\))/gi)
        const tagNumberText = inputText.match(getTagNumbersRegex)
        if (!tagNumberText) return fallback || null

        const tagNumbers = tagNumberText.reduce((numbers, text) => {
            let tagNumber = text.match(/\d+/)
            tagNumber = tagNumber && tagNumber.length ? tagNumber[0] : null

            if (!tagNumber) return numbers

            const number = Number.parseInt(tagNumber)
            if (numbers.indexOf(number) == -1) numbers.push(number)

            return numbers
        }, [])

        if (!tagNumbers.length && fallback) {
            this.cache.set(cacheKey, fallback)
            return fallback
        }

        this.cache.set(cacheKey, tagNumbers)
        return tagNumbers
    }

    getGPSLocationFromText(inputText, fallback) {
        const cacheKey = `${this.cacheKeys.gpsLocationText}${inputText}`
        const existingParsed = this.cache.get(cacheKey)
        if (existingParsed) return existingParsed

        /// TODO: build out testers for all current games of BikeTag on Reddit
        const getGPSLocationRegex = new RegExp(
            /(([0-9]{1,2})[:|°]([0-9]{1,2})[:|'|′]?([0-9]{1,2}(?:\.[0-9]+){0,1})?["|″]([N|S]),?\s*([0-9]{1,3})[:|°]([0-9]{1,2})[:|'|′]?([0-9]{1,2}(?:\.[0-9]+){0,1})?["|″]([E|W]))|((-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?))/g,
        )
        /// Normalize the text (some posts found to have this escaped double quote placed in between GPS coordinates)
        inputText = inputText.replace(/\\/g, '')
        const gpsLocationText = getGPSLocationRegex.exec(inputText)

        if (!gpsLocationText) {
            fallback = fallback || null
            this.cache.set(cacheKey, fallback)

            return fallback
        }

        const gpsLocation = gpsLocationText[0] || null
        this.cache.set(cacheKey, gpsLocation)
        return gpsLocation
    }

    getImageURLsFromText(inputText, fallback) {
        const cacheKey = `${this.cacheKeys.imagesText}${inputText}`
        const existingParsed = this.cache.get(cacheKey)
        if (existingParsed) return existingParsed

        /// TODO: make this image validator more intelligent
        const validImageURLs = ['imgur']

        const selfTextURLs = inputText.match(/(?:])(?:\()(https?:\/\/.*?\.[a-z]{2,4}\/[^\s)]*)/gi) || []
        const tagImageURLs = selfTextURLs.reduce((urls, url) => {
            if (!url || !new RegExp(validImageURLs.join('|')).test(url)) return urls

            urls.push(url)

            return urls
        }, [])

        if (!tagImageURLs.length && fallback) {
            this.cache.set(cacheKey, fallback)
            return fallback
        }

        this.cache.set(cacheKey, tagImageURLs)
        return tagImageURLs
    }

    setCache(cache, cacheKeys) {
        this.cache = cache
        this.cacheKeys = !!cacheKeys ? cacheKeys : this.cacheKeys

        // const setCache = this.cache.set
        // this.cache.set = (key, val) => {
        // 	console.log({key, setting: val})
        // 	return setCache(key, val)
        // }
    }

    setLogger(logger) {
        this.log = logger
    }
}

class BikeTagApiFactory {
    constructor() {
        /// If we already have an instance, return it
        if (singleton) return singleton.instance

        // create a unique, global symbol namespace
        // -----------------------------------
        const globalNamespace = Symbol.for(namespace)

        // check if the global object has this symbol
        // add it if it does not have the symbol, yet
        // ------------------------------------------
        var globalSymbols = Object.getOwnPropertySymbols(global)
        var utilInitialized = globalSymbols.indexOf(globalNamespace) > -1

        /// This should always be uninitialized, probably
        if (!utilInitialized) {
            global[globalNamespace] = new BikeTagApi()

            // define the singleton API
            // ------------------------
            singleton = {}

            Object.defineProperty(singleton, 'instance', {
                get: function () {
                    return global[globalNamespace]
                },
            })

            // ensure the API is never changed
            // -------------------------------
            Object.freeze(singleton)
        }

        // export the singleton API only
        // -----------------------------
        return singleton.instance
    }
}

module.exports = new BikeTagApiFactory()
module.exports.BikeTagModel = BikeTagModel
module.exports.BikeTagApi = BikeTagApi
module.exports.namespace = namespace
