        );

        return res.sendStatus(statusCode);
    } catch (error) {
        console.error('eBay notification verification failed.');
        return res.sendStatus(500);
    }
});

app.get('/', (req, res) => {
    res.status(200).send('eBay notification service is running.');
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
    console.log('eBay notification service started.');
});
